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

}
