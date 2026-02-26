import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject } from 'rxjs';
import { HttpClient } from '@angular/common/http';

export interface ChatMessage {
  user: string;
  message: string;
  isSystem?: boolean;
  eventType?: 'join' | 'leave';
}

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private hubConnection: signalR.HubConnection;
  private backendUrl = 'http://localhost:5000'; // ASP.NET Core default HTTP port

  public messages$ = new BehaviorSubject<ChatMessage[]>([]);
  public onlineUsers$ = new BehaviorSubject<string[]>([]);
  public currentUser: string = '';

  constructor(private http: HttpClient) {
    this.hubConnection = new signalR.HubConnectionBuilder()
      .withUrl(`${this.backendUrl}/chathub`)
      .withAutomaticReconnect()
      .build();

    this.setupListeners();
  }

  private setupListeners() {
    this.hubConnection.on('MessageReceived', (user: string, message: string) => {
      const currentMessages = this.messages$.value;
      const cleaned = message.replace(/\n/g, '<br>');
      this.messages$.next([...currentMessages, { user, message: cleaned }]);
    });

    this.hubConnection.on('UserJoined', (user: string) => {
      if (user !== this.currentUser && !this.onlineUsers$.value.includes(user)) {
        this.onlineUsers$.next([...this.onlineUsers$.value, user]);
      }
      const currentMessages = this.messages$.value;
      this.messages$.next([...currentMessages, { user, message: `+ ${user} joined.`, isSystem: true, eventType: 'join' }]);
    });

    this.hubConnection.on('UserLeft', (user: string) => {
      const currentUsers = this.onlineUsers$.value.filter(u => u !== user);
      this.onlineUsers$.next(currentUsers);
      const currentMessages = this.messages$.value;
      this.messages$.next([...currentMessages, { user, message: `- ${user} left.`, isSystem: true, eventType: 'leave' }]);
    });
  }

  public async startConnection(username: string): Promise<boolean> {
    try {
      if (this.hubConnection.state !== signalR.HubConnectionState.Connected) {
        await this.hubConnection.start();
      }

      const success = await this.hubConnection.invoke<boolean>('JoinChat', username);

      if (success) {
        this.currentUser = username;

        // Fetch current online users
        const users = await this.hubConnection.invoke<string[]>('GetOnlineUsers');
        this.onlineUsers$.next(users);

        return true;
      } else {
        await this.hubConnection.stop();
        return false;
      }
    } catch (err) {
      console.error('Error starting connection: ' + err);
      return false;
    }
  }

  public async sendMessage(message: string) {
    if (this.hubConnection.state === signalR.HubConnectionState.Connected) {
      await this.hubConnection.invoke('SendMessage', message);
    }
  }
}

