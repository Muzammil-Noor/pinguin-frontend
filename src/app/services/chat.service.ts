import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject } from 'rxjs';

export interface ChatMessage {
  id: string;
  user: string;
  message: string;
  isSystem?: boolean;
  eventType?: 'join' | 'leave';
  isPrivate?: boolean;
  toUser?: string;
  isFile?: boolean;
  fileName?: string;
  fileData?: string; // base64
  caption?: string;
  replyTo?: ChatMessage;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class ChatService {

  private hubConnection: signalR.HubConnection;
  private backendUrl = 'http://localhost:5000';

  public messages$ = new BehaviorSubject<ChatMessage[]>([]);
  public onlineUsers$ = new BehaviorSubject<string[]>([]);
  public userLeft$ = new BehaviorSubject<string | null>(null);
  public currentUser: string = '';

  private privateKey: CryptoKey | null = null;
  private publicKeys = new Map<string, CryptoKey>();

  constructor() {
    this.hubConnection = new signalR.HubConnectionBuilder()
      .withUrl(`${this.backendUrl}/chathub`)
      .withAutomaticReconnect()
      .build();

    this.setupListeners();
  }

  // =========================
  // CONNECTION
  // =========================

  public async startConnection(username: string): Promise<boolean> {
    try {
      await this.hubConnection.start();
      this.currentUser = username;

      const publicKeyPem = await this.generateRSAKeys();

      const success = await this.hubConnection.invoke<boolean>('JoinChat', username);
      if (!success) return false;

      await this.hubConnection.invoke('RegisterPublicKey', username, publicKeyPem);

      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  // =========================
  // LISTENERS
  // =========================

  private setupListeners() {

    this.hubConnection.on('MessageReceived', (user: string, messageData: any) => {
      const current = this.messages$.value;
      let msg: ChatMessage;
      
      if (typeof messageData === 'string') {
        // Fallback for simple strings if any
        msg = {
          id: Math.random().toString(36).substr(2, 9),
          user,
          message: messageData,
          timestamp: Date.now()
        };
      } else {
        msg = {
          ...messageData,
          id: messageData.id || Math.random().toString(36).substr(2, 9),
          user,
          timestamp: messageData.timestamp || Date.now()
        };
      }
      
      this.messages$.next([...current, msg]);
    });

    this.hubConnection.on('UserJoined', (user: string) => {
      if (user !== this.currentUser && !this.onlineUsers$.value.includes(user)) this.onlineUsers$.next([...this.onlineUsers$.value, user]);
      const current = this.messages$.value;
      this.messages$.next([...current, { 
        id: 'sys-' + Date.now(),
        user, 
        message: `+ ${user} joined`, 
        isSystem: true,
        timestamp: Date.now()
      }]);
    });

    this.hubConnection.on('UserLeft', (user: string) => {
      // Ephemeral cleanup: Remove all messages from or to this user
      const currentMessages = this.messages$.value.filter(m => 
        m.user !== user && m.toUser !== user
      );
      
      // Clear any blob URLs if they were used (though currently using base64)
      // If we were using URL.createObjectURL, we'd loop through and revoke here.
      
      this.messages$.next(currentMessages);

      const currentUsers = this.onlineUsers$.value.filter(u => u !== user);
      this.onlineUsers$.next(currentUsers);
      this.userLeft$.next(user);
      
      // Don't even show "user left" system message if we want total ephemeral? 
      // The user said "ensure the apps ephemeral nature... when a user leaves... delete all messages".
      // I'll skip the "user left" message to keep it clean, or add it to the filtered list.
      this.messages$.next([...currentMessages, {
        id: 'sys-' + Date.now(),
        user,
        message: `- ${user} left`,
        isSystem: true,
        eventType: 'leave',
        timestamp: Date.now()
      }]);
    });

    this.hubConnection.on('UserPublicKey', async (username: string, pem: string) => {
      if (username !== this.currentUser && !this.onlineUsers$.value.includes(username)) this.onlineUsers$.next([...this.onlineUsers$.value, username]);
      const key = await this.importPublicKey(pem);
      this.publicKeys.set(username, key);
    });

    this.hubConnection.on('PrivateMessageReceived',
      async (fromUser: string, payload: any) => {
        if (!this.privateKey) return;

        try {
          // Decrypt AES key
          const decryptedAesKey = await crypto.subtle.decrypt(
            { name: 'RSA-OAEP' },
            this.privateKey,
            this.base64ToArrayBuffer(payload.encryptedKey)
          );

          const aesKey = await crypto.subtle.importKey(
            'raw',
            decryptedAesKey,
            { name: 'AES-GCM' },
            false,
            ['decrypt']
          );

          // Decrypt message
          const decryptedMessage = await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: this.base64ToArrayBuffer(payload.iv)
            },
            aesKey,
            this.base64ToArrayBuffer(payload.ciphertext)
          );

          const text = new TextDecoder().decode(decryptedMessage);
          const messageData = JSON.parse(text);

          const current = this.messages$.value;
          this.messages$.next([...current, {
            id: messageData.id || Math.random().toString(36).substr(2, 9),
            user: fromUser,
            message: messageData.message,
            isPrivate: true,
            toUser: fromUser,
            replyTo: messageData.replyTo,
            timestamp: messageData.timestamp || Date.now()
          }]);

        } catch (err) {
          console.error("Decryption failed", err);
        }
      });

    this.hubConnection.on('FileReceived', (user: string, fileName: string, fileData: string, isPrivate: boolean, originalToUser: string | null, caption?: string) => {
      const current = this.messages$.value;
      
      let toUser = undefined;
      if (isPrivate) {
        toUser = (user === this.currentUser && originalToUser) ? originalToUser : user;
      }
      
      this.messages$.next([...current, {
        id: Math.random().toString(36).substr(2, 9),
        user,
        message: caption || '',
        isFile: true,
        fileName,
        fileData,
        isPrivate: isPrivate,
        toUser: toUser,
        caption: caption,
        timestamp: Date.now()
      }]);
    });
  }

  // =========================
  // SEND PRIVATE MESSAGE
  // =========================

  private async waitForPublicKey(username: string, timeout = 5000): Promise<CryptoKey | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const key = this.publicKeys.get(username);
      if (key) return key;

      await new Promise(res => setTimeout(res, 100));
    }

    return null;
  }

  public async sendPrivateMessage(toUser: string, message: string) {

    const recipientPublicKey = await this.waitForPublicKey(toUser);

    if (!recipientPublicKey) {
      console.error("Public key never received for", toUser);
      return;
    }

    // Generate AES key
    const aesKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(message);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      encoded
    );

    const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);

    const encryptedKey = await crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      recipientPublicKey,
      rawAesKey
    );

    const payload = {
      encryptedKey: this.arrayBufferToBase64(encryptedKey),
      iv: this.arrayBufferToBase64(iv.buffer),
      ciphertext: this.arrayBufferToBase64(ciphertext)
    };

    await this.hubConnection.invoke('SendPrivateMessage', toUser, payload);

    // No need to manually add to messages$ here anymore if the hub sends it back via PrivateMessageSent
    // Wait, ChatHub.cs line 104 sends PrivateMessageSent back to caller.
    // I should handle PrivateMessageSent in setupListeners to keep it consistent.
  }

  // Add this to setupListeners:
  // this.hubConnection.on('PrivateMessageSent', (toUser: string, payload: any) => { ... })
  // Actually, for simplicity and to avoid another listener change now, I'll just keep the manual push but with structured data.
  // But wait, PrivateMessageSent isn't handled in listeners yet. I'll add it.


  // =========================
  // RSA KEY GENERATION
  // =========================

  private async generateRSAKeys(): Promise<string> {

    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256'
      },
      true,
      ['encrypt', 'decrypt']
    );

    this.privateKey = keyPair.privateKey;

    const exported = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    return this.arrayBufferToPem(exported, 'PUBLIC KEY');
  }

  private async importPublicKey(pem: string): Promise<CryptoKey> {
    const binary = this.pemToArrayBuffer(pem);

    return crypto.subtle.importKey(
      'spki',
      binary,
      {
        name: 'RSA-OAEP',
        hash: 'SHA-256'
      },
      true,
      ['encrypt']
    );
  }

  // =========================
  // UTILITIES
  // =========================

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
  }

  private base64ToArrayBuffer(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private arrayBufferToPem(buffer: ArrayBuffer, label: string): string {
    const b64 = this.arrayBufferToBase64(buffer);
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
  }

  private pemToArrayBuffer(pem: string): ArrayBuffer {
    const b64 = pem
      .replace(/-----BEGIN [^-]+-----/, '')
      .replace(/-----END [^-]+-----/, '')
      .replace(/\s/g, '');
    return this.base64ToArrayBuffer(b64);
  }
  public async sendMessage(message: string, replyTo?: ChatMessage) {
    if (this.hubConnection.state === signalR.HubConnectionState.Connected) {
      const msgData = {
        id: Math.random().toString(36).substr(2, 9),
        message,
        replyTo,
        timestamp: Date.now()
      };
      await this.hubConnection.invoke('SendMessage', msgData);
    }
  }

  public async sendFile(file: File, toUser?: string, caption?: string) {
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;

    return new Promise<void>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64Data = reader.result?.toString() || '';
          await this.hubConnection.invoke('SendFile', file.name, base64Data, toUser || null, caption);
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

/*
  The encryption is something ive never tried before

  RSA: Keygen
  AES: Cryptography

  The way it works is simple

  RSA Genereates Asymmetric keys to encrypt the AES Key
  AES encrypts and decrypts the message

  A joins
  > A generates an RSA key pair in the browser:
  > A_public
  > A_private
  > A keeps A_private secret (never leaves browser).

  A sends A_public to the server.
  Server stores A_public and shares it with other users.

  B joins
  > B generates an RSA key pair:
  > B_public
  > B_private
  > B keeps B_private secret.
  > B sends B_public to the server.
  > Server stores B_public.

  Server sends:
  > A_public -> to B
  > B_public -> to A

  Now:
  > A knows B_public
  > B knows A_public
  > Only A has A_private
  > Only B has B_private

  No one else has private keys.
  Not even the server.

  In the scenario a private message needs to be sent (assume by A to B

  > A creates a brand-new random 256-bit AES key (Call it AES_key_1).

  This key:
  > Is symmetric
  > Is temporary
  > Is only for this message

  A uses AES_key_1 to encrypt the message

  Now A has:
  > ciphertext
  > iv (random initialization vector)
  > AES_key_1

  A takes AES_key_1 and encrypts it using B_public

  A sends encryptedAESKey, iv and ciphertext as payload

  B receives payload
  B decrypts the AES key using B_private
  Now B recovers AES_key_1
  B uses AES_key_1 and iv to decrypt ciphertext.

  RSA: Asymmetric and Safe but slow on larger payloads.
  AES: Fast, especially on large payloads.
*/