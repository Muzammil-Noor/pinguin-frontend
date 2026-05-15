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

}
