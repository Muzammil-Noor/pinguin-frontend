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

  // RSA key handling
  private privateKey: CryptoKey | null = null;
  private publicKeys = new Map<string, CryptoKey>();

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

    this.hubConnection.on('PrivateMessageReceived', async (fromUser: string, encryptedB64: string, isEcho: boolean) => {
      const currentMessages = this.messages$.value;

      let decryptedText = encryptedB64;

      // Only decrypt if this is NOT echo (echo is already encrypted with recipient's key)
      if (!isEcho && this.privateKey) {
        try {
          const encryptedBytes = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
          const decryptedBuffer = await window.crypto.subtle.decrypt(
            { name: 'RSA-OAEP' },
            this.privateKey,
            encryptedBytes
          );

          decryptedText = new TextDecoder().decode(decryptedBuffer);
        } catch (err) {
          console.error("Decryption failed:", err);
          decryptedText = "[Decryption failed]";
        }
        const cleaned = decryptedText.replace(/\n/g, '<br>');
        const actualSender = isEcho ? this.currentUser : fromUser;

        this.messages$.next([...currentMessages, {
          user: actualSender,
          message: cleaned,
          isPrivate: true,
          toUser: isEcho ? fromUser : fromUser
        }]);
      }
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
    // Receive private key
    this.hubConnection.on('ReceivePrivateKey', async (privateKeyPem: string) => {
      this.privateKey = await this.importPrivateKey(privateKeyPem);
    });

    // Receive public key for a user
    this.hubConnection.on('UserPublicKey', async (username: string, publicKeyPem: string) => {
      const key = await this.importPublicKey(publicKeyPem);
      this.publicKeys.set(username, key);
      console.log("key recieved")
    });
  }

  private async importPublicKey(pem: string): Promise<CryptoKey> {
    const binaryDer = this.pemToArrayBuffer(pem);
    return await window.crypto.subtle.importKey(
      'spki',
      binaryDer,
      {
        name: 'RSA-OAEP',
        hash: 'SHA-256'
      },
      true,
      ['encrypt']
    );
  }

  private async importPrivateKey(pem: string): Promise<CryptoKey> {
    const binaryDer = this.pemToArrayBuffer(pem);
    return await window.crypto.subtle.importKey(
      'pkcs8',
      binaryDer,
      {
        name: 'RSA-OAEP',
        hash: 'SHA-256'
      },
      true,
      ['decrypt']
    );
  }

  private pemToArrayBuffer(pem: string): ArrayBuffer {
    const b64 = pem
      .replace(/-----BEGIN [^-]+-----/, '')
      .replace(/-----END [^-]+-----/, '')
      .replace(/\s/g, '');

    const binary = window.atob(b64);
    const buffer = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      buffer[i] = binary.charCodeAt(i);
    }

    return buffer.buffer;
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
      // Encrypt message with recipient's public key
      const pubKey = this.publicKeys.get(toUser);
      if (!pubKey) {
        console.error('Public key for recipient not found');
        return;
      }
      const encoder = new TextEncoder();
      const data = encoder.encode(message);
      const encrypted = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, data);
      const encryptedB64 = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
      await this.hubConnection.invoke('SendPrivateMessage', toUser, encryptedB64);
      const cleaned = message.replace(/\n/g, '<br>');
      const currentMessages = this.messages$.value;
      this.messages$.next([...currentMessages, {
        user: this.currentUser,
        message: cleaned,
        isPrivate: true,
        toUser
      }]);
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

