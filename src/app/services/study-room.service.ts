import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ChatService, ChatMessage } from './chat.service';
import * as signalR from '@microsoft/signalr';

export interface StudyRoom {
  id: string;
  owner: string;
  members: string[];
  createdAt: number;
  expiresAt: string; // ISO string from backend
}

export interface StudyRoomMessage extends ChatMessage {
  roomId: string;
  isPingu?: boolean;
  prompt?: string;
}

export interface StudyRoomInvite {
  inviteId: string;
  inviter: string;
  members: string[];
}

@Injectable({
  providedIn: 'root'
})
export class StudyRoomService {
  public studyRooms$ = new BehaviorSubject<StudyRoom[]>([]);
  public studyRoomMessages$ = new BehaviorSubject<StudyRoomMessage[]>([]);
  public pendingInvites$ = new BehaviorSubject<StudyRoomInvite[]>([]);
  public pinguTyping$ = new BehaviorSubject<Map<string, boolean>>(new Map());

  constructor(private chatService: ChatService) {
    this.setupListeners();

    // A block hides that user's messages everywhere, study rooms included.
    this.chatService.purgeUser$.subscribe(username => {
      this.studyRoomMessages$.next(
        this.studyRoomMessages$.value.filter(m => m.user !== username)
      );
    });
  }

  private setupListeners() {
    const hub = this.chatService['hubConnection'];

    hub.on('StudyRoomInviteReceived', (invite: StudyRoomInvite) => {
      const current = this.pendingInvites$.value;
      this.pendingInvites$.next([...current, invite]);
    });

    hub.on('StudyRoomInviteAccepted', (inviteId: string, username: string) => {
      // Could show a notification: "X accepted the invite"
    });

    hub.on('StudyRoomInviteDeclined', (inviteId: string, username: string) => {
      this.pendingInvites$.next(this.pendingInvites$.value.filter(i => i.inviteId !== inviteId));
    });

    hub.on('StudyRoomInviteCancelled', (inviteId: string, reason: string) => {
      this.pendingInvites$.next(this.pendingInvites$.value.filter(i => i.inviteId !== inviteId));
    });

    hub.on('StudyRoomInviteExpired', (inviteId: string) => {
      this.pendingInvites$.next(this.pendingInvites$.value.filter(i => i.inviteId !== inviteId));
    });

    hub.on('StudyRoomCreated', (room: any) => {
      const formattedRoom: StudyRoom = {
        ...room,
        createdAt: new Date(room.createdAt).getTime(),
        expiresAt: room.expiresAt
      };
      this.studyRooms$.next([...this.studyRooms$.value, formattedRoom]);
      // Remove the invite if it exists
      this.pendingInvites$.next(this.pendingInvites$.value.filter(i => 
        i.members.sort().join(',') === room.members.sort().join(',') || // heuristic if we don't have inviteId here
        i.inviter === room.owner
      ));
    });

    hub.on('StudyRoomDeleted', (roomId: string) => {
      this.studyRooms$.next(this.studyRooms$.value.filter(r => r.id !== roomId));
    });

    hub.on('StudyRoomExpired', (roomId: string) => {
      this.studyRooms$.next(this.studyRooms$.value.filter(r => r.id !== roomId));
    });

    hub.on('StudyRoomMemberLeft', (roomId: string, username: string, newOwner: string | null) => {
      const rooms = this.studyRooms$.value.map(r => {
        if (r.id === roomId) {
          return {
            ...r,
            members: r.members.filter(m => m !== username),
            owner: newOwner || r.owner
          };
        }
        return r;
      });
      this.studyRooms$.next(rooms);
    });

    hub.on('StudyRoomMessageReceived', (roomId: string, user: string, messageData: any) => {
      const msg: StudyRoomMessage = {
        ...messageData,
        id: messageData.id || Math.random().toString(36).substr(2, 9),
        roomId,
        user,
        timestamp: messageData.timestamp || Date.now()
      };
      this.studyRoomMessages$.next([...this.studyRoomMessages$.value, msg]);
    });

    hub.on('PinguResponse', (roomId: string, prompt: string, response: string, timestamp: string) => {
      const msg: StudyRoomMessage = {
        id: 'pingu-' + Date.now(),
        roomId,
        user: 'Pingu',
        message: response,
        prompt: prompt,
        isPingu: true,
        timestamp: new Date(timestamp).getTime()
      };
      this.studyRoomMessages$.next([...this.studyRoomMessages$.value, msg]);
    });

    hub.on('PinguTyping', (roomId: string, isTyping: boolean) => {
      const current = new Map(this.pinguTyping$.value);
      current.set(roomId, isTyping);
      this.pinguTyping$.next(current);
    });
  }

  public async createStudyRoom(invitedUsernames: string[]): Promise<string | null> {
    return await this.chatService['hubConnection'].invoke<string | null>('CreateStudyRoom', invitedUsernames);
  }

  public async respondToInvite(inviteId: string, accept: boolean): Promise<boolean> {
    const success = await this.chatService['hubConnection'].invoke<boolean>('RespondToStudyRoomInvite', inviteId, accept);
    if (success || !accept) {
      this.pendingInvites$.next(this.pendingInvites$.value.filter(i => i.inviteId !== inviteId));
    }
    return success;
  }

  public async leaveStudyRoom(roomId: string): Promise<void> {
    await this.chatService['hubConnection'].invoke('LeaveStudyRoom', roomId);
  }

  public async sendMessage(roomId: string, message: string) {
    const payload = {
      id: Math.random().toString(36).substr(2, 9),
      message,
      timestamp: Date.now()
    };

    await this.chatService['hubConnection'].invoke('SendStudyRoomMessage', roomId, payload);

    // Detect @Pingu mention
    const pinguMatch = message.match(/^@Pingu\s+(.+)/i);
    if (pinguMatch) {
      const prompt = pinguMatch[1].trim();
      await this.chatService['hubConnection'].invoke('PromptPingu', roomId, prompt);
    }
  }

  public async fetchStudyRooms() {
    const rooms = await this.chatService['hubConnection'].invoke<any[]>('GetStudyRooms');
    const formatted = rooms.map(r => ({
      ...r,
      createdAt: new Date(r.createdAt).getTime(),
      expiresAt: r.expiresAt
    }));
    this.studyRooms$.next(formatted);
  }
}
