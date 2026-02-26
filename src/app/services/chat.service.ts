import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject } from 'rxjs';
import { HttpClient } from '@angular/common/http';

export interface ChatMessage {
  user: string; // sender
  message: string;
  isSystem?: boolean;
  eventType?: 'join' | 'leave';
  isPrivate?: boolean;
  toUser?: string; // either 'global' or the target username
  isFile?: boolean;
  fileName?: string;
  fileData?: string; // base64
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
      this.messages$.next([...currentMessages, { user, message: cleaned, toUser: 'global' }]);
    });

    this.hubConnection.on('UserJoined', (user: string) => {
      if (user !== this.currentUser && !this.onlineUsers$.value.includes(user)) {
        this.onlineUsers$.next([...this.onlineUsers$.value, user]);
      }
      const currentMessages = this.messages$.value;
      this.messages$.next([...currentMessages, { user, message: `+ ${user} joined.`, isSystem: true, eventType: 'join', toUser: 'global' }]);
    });

    this.hubConnection.on('UserLeft', (user: string) => {
      const currentUsers = this.onlineUsers$.value.filter(u => u !== user);
      this.onlineUsers$.next(currentUsers);
      const currentMessages = this.messages$.value;
      this.messages$.next([...currentMessages, { user, message: `- ${user} left.`, isSystem: true, eventType: 'leave', toUser: 'global' }]);
    });

    this.hubConnection.on('PrivateMessageReceived', (fromUser: string, message: string, isEcho: boolean) => {
      const currentMessages = this.messages$.value;
      const cleaned = message.replace(/\n/g, '<br>');
      // If echo, isPrivate true but fromUser technically is the target in the echo response
      const targetChat = isEcho ? fromUser : fromUser;
      const actualSender = isEcho ? this.currentUser : fromUser;

      this.messages$.next([...currentMessages, {
        user: actualSender,
        message: cleaned,
        isPrivate: true,
        toUser: targetChat
      }]);
    });

    this.hubConnection.on('FileReceived', (fromUser: string, fileName: string, fileData: string, privateTargetContext: string | null) => {
      const currentMessages = this.messages$.value;
      const targetChat = privateTargetContext ? privateTargetContext : 'global';

      this.messages$.next([...currentMessages, {
        user: fromUser,
        message: '',
        isFile: true,
        fileName,
        fileData,
        isPrivate: !!privateTargetContext,
        toUser: targetChat
      }]);
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

  public async sendPrivateMessage(toUser: string, message: string) {
    if (this.hubConnection.state === signalR.HubConnectionState.Connected) {
      await this.hubConnection.invoke('SendPrivateMessage', toUser, message);
    }
  }

  public async sendFile(file: File, toUser?: string) {
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;

    return new Promise<void>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64Data = reader.result?.toString() || '';
          await this.hubConnection.invoke('SendFile', file.name, base64Data, toUser || null);
          resolve();
        } catch (err) {
          console.error(err);
          reject(err);
        }
      };
      reader.onerror = error => reject(error);
      reader.readAsDataURL(file);
    });
  }
}

