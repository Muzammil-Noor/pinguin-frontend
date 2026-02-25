import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject } from 'rxjs';
import { HttpClient } from '@angular/common/http';

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private hubConnection: signalR.HubConnection;
  private backendUrl = 'http://localhost:5000'; // ASP.NET Core default HTTP port

  public messages$ = new BehaviorSubject<{ user: string, message: string }[]>([]);
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
      this.messages$.next([...currentMessages, { user, message }]);
    });

    this.hubConnection.on('UserJoined', (user: string) => {
      // In a real app we'd fetch the list, but for MVP we might just append if we don't have the full list
      // Or better, let the server send the full list occasionally. 
      // For now, let's just keep track simply.
      console.log(`${user} joined`);
    });

    this.hubConnection.on('UserLeft', (user: string) => {
      const currentUsers = this.onlineUsers$.value.filter(u => u !== user);
      this.onlineUsers$.next(currentUsers);
      console.log(`${user} left`);
    });
  }

  public async startConnection(username: string): Promise<boolean> {
    try {
      // 1. Validate username
      const validateRes = await this.http.post<{ available: boolean }>(`${this.backendUrl}/username/validate`, { username }).toPromise();
      if (!validateRes?.available) {
        return false;
      }

      // 2. Start SignalR connection
      await this.hubConnection.start();

      // 3. Set username internally on backend
      const setRes = await this.http.post<{ success: boolean }>(`${this.backendUrl}/username/set`, {
        connectionId: this.hubConnection.connectionId,
        username
      }).toPromise();

      if (setRes?.success) {
        this.currentUser = username;
        // Add self to online users for display purposes
        this.onlineUsers$.next([...this.onlineUsers$.value, username]);
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

