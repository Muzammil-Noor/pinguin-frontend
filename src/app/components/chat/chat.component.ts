import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService, ChatMessage, Chatroom, RoomMessage } from '../../services/chat.service';
import { StudyRoomService, StudyRoom, StudyRoomMessage, StudyRoomInvite } from '../../services/study-room.service';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent implements OnInit, OnDestroy {
  messages: ChatMessage[] = [];
  onlineUsers: string[] = [];
  activeTab: 'users' | 'rooms' = 'users';
  currentUser: string = '';
  newMessage: string = '';
  activeChat: string = 'global';
  openDMs: string[] = [];
  unreadDMs: Set<string> = new Set<string>();

  chatrooms: Chatroom[] = [];
  roomMessages: RoomMessage[] = [];
  unreadRooms: Set<string> = new Set<string>();

  // Study Rooms
  studyRooms: StudyRoom[] = [];
  studyRoomMessages: StudyRoomMessage[] = [];
  unreadStudyRooms: Set<string> = new Set<string>();
  pendingInvites: StudyRoomInvite[] = [];
  pinguTypingMap: Map<string, boolean> = new Map();

  showCreateRoomModal = false;
  newRoomName = '';
  showRenameRoomModal = false;
  roomToRename: Chatroom | null = null;
  renameRoomName = '';
  showInviteModal = false;
  roomToInvite: Chatroom | null = null;
  selectedUserToInvite = '';
  showRoomMenu = false;

  // Study Room specific
  showCreateStudyRoomModal = false;
  selectedStudyMembers: Set<string> = new Set();

  replyingTo: ChatMessage | null = null;
  selectedFiles: { file: File, preview: string, type: string }[] = [];

  private subs = new Subscription();
  private timerInterval: any;

  constructor(
    private chatService: ChatService, 
    private studyRoomService: StudyRoomService,
    private router: Router
  ) {
    this.currentUser = this.chatService.currentUser;
  }

  get filteredMessages(): (ChatMessage | RoomMessage | StudyRoomMessage)[] {
    if (this.activeChat === 'global') {
      return this.messages.filter(m => !m.isPrivate);
    }
    
    // Study Room
    const studyRoom = this.studyRooms.find(r => r.id === this.activeChat);
    if (studyRoom) {
      return this.studyRoomMessages.filter(m => m.roomId === this.activeChat);
    }

    // Chatroom
    const room = this.chatrooms.find(r => r.id === this.activeChat);
    if (room) {
      return this.roomMessages.filter(m => m.roomId === this.activeChat);
    }
    
    // DM
    return this.messages.filter(m => 
      m.isPrivate && 
      (m.user === this.activeChat || (m.user === this.currentUser && m.toUser === this.activeChat))
    );
  }

  get activeRoom(): Chatroom | undefined {
    return this.chatrooms.find(r => r.id === this.activeChat);
  }

  get availableUsersToInvite(): string[] {
    if (!this.roomToInvite) return [];
    return this.onlineUsers.filter(u => !this.roomToInvite!.members.includes(u));
  }

  setTab(tab: 'users' | 'rooms') {
    this.activeTab = tab;
  }

  openDM(username: string) {
    if (username === this.currentUser) return;
    if (!this.openDMs.includes(username)) {
      this.openDMs.push(username);
    }
    this.activeChat = username;
    this.unreadDMs.delete(username);
  }

  hasUnread(user: string): boolean {
    return this.unreadDMs.has(user);
  }

  setActiveChat(chatId: string) {
    this.activeChat = chatId;
    this.unreadRooms.delete(chatId);
    this.unreadStudyRooms.delete(chatId);
    this.showRoomMenu = false;
  }

  setReply(msg: ChatMessage) {
    if (msg.isSystem) return;
    this.replyingTo = msg;
    // Focus textarea
    setTimeout(() => {
      const textarea = document.querySelector('textarea');
      if (textarea) textarea.focus();
    }, 100);
  }

  cancelReply() {
    this.replyingTo = null;
  }

  removeFile(index: number) {
    this.selectedFiles.splice(index, 1);
  }

  openCreateRoom() {
    this.newRoomName = '';
    this.showCreateRoomModal = true;
  }

  async createRoom() {
    if (!this.newRoomName.trim()) return;
    const room = await this.chatService.createRoom(this.newRoomName);
    if (room) {
      this.activeChat = room.id;
    }
    this.showCreateRoomModal = false;
  }

  openRenameRoom(room: Chatroom) {
    this.roomToRename = room;
    this.renameRoomName = room.name;
    this.showRenameRoomModal = true;
    this.showRoomMenu = false;
  }

  async renameRoom() {
    if (this.roomToRename && this.renameRoomName.trim()) {
      await this.chatService.renameRoom(this.roomToRename.id, this.renameRoomName);
    }
    this.showRenameRoomModal = false;
  }

  async deleteRoom(room: Chatroom) {
    await this.chatService.deleteRoom(room.id);
    if (this.activeChat === room.id) this.activeChat = 'global';
    this.showRoomMenu = false;
  }

  async leaveRoom(room: Chatroom) {
    await this.chatService.leaveRoom(room.id);
    if (this.activeChat === room.id) this.activeChat = 'global';
    this.showRoomMenu = false;
  }

  openInvite(room: Chatroom) {
    this.roomToInvite = room;
    this.selectedUserToInvite = '';
    this.showInviteModal = true;
    this.showRoomMenu = false;
  }

  async inviteUser() {
    if (this.roomToInvite && this.selectedUserToInvite) {
      await this.chatService.inviteToRoom(this.roomToInvite.id, this.selectedUserToInvite);
    }
    this.showInviteModal = false;
  }

  async kickUser(room: Chatroom | StudyRoom, username: string) {
    if ('id' in room && !('expiresAt' in room)) {
      await this.chatService.kickFromRoom((room as Chatroom).id, username);
    }
  }

  // Study Rooms
  openCreateStudyRoom() {
    this.selectedStudyMembers.clear();
    this.showCreateStudyRoomModal = true;
  }

  toggleStudyMember(username: string) {
    if (this.selectedStudyMembers.has(username)) {
      this.selectedStudyMembers.delete(username);
    } else {
      this.selectedStudyMembers.add(username);
    }
  }

  async createStudyRoom() {
    if (this.selectedStudyMembers.size === 0) return;
    const members = Array.from(this.selectedStudyMembers);
    await this.studyRoomService.createStudyRoom(members);
    this.showCreateStudyRoomModal = false;
  }

  async respondToInvite(inviteId: string, accept: boolean) {
    await this.studyRoomService.respondToInvite(inviteId, accept);
  }

  get activeStudyRoom(): StudyRoom | undefined {
    return this.studyRooms.find(r => r.id === this.activeChat);
  }

  getRemainingTime(room: StudyRoom): string {
    const expires = new Date(room.expiresAt).getTime();
    const now = Date.now();
    const diff = expires - now;

    if (diff <= 0) return '00:00:00';

    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);

    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  isExpiringSoon(room: StudyRoom): boolean {
    const expires = new Date(room.expiresAt).getTime();
    const now = Date.now();
    return (expires - now) < 600000; // 10 minutes
  }

  isPinguTyping(roomId: string): boolean {
    return this.pinguTypingMap.get(roomId) || false;
  }

  ngOnInit() {
    if (!this.currentUser) {
      this.router.navigate(['/']);
      return;
    }

    let previousMessageCount = 0;
    this.subs.add(
      this.chatService.messages$.subscribe(msgs => {
        const newMsgs = msgs.slice(previousMessageCount);
        previousMessageCount = msgs.length;
        this.messages = msgs;

        newMsgs.forEach(m => {
          if (m.isPrivate) {
            const otherUser = m.user === this.currentUser ? m.toUser : m.user;
            if (otherUser && otherUser !== 'global' && otherUser !== this.currentUser) {
              if (!this.openDMs.includes(otherUser)) {
                this.openDMs.push(otherUser);
              }
              if (otherUser !== this.activeChat && m.user !== this.currentUser) {
                this.unreadDMs.add(otherUser);
              }
            }
          }
        });

        setTimeout(() => {
          const scrollable = document.querySelector('.custom-scrollbar');
          if (scrollable) {
            scrollable.scrollTop = scrollable.scrollHeight;
          }
        }, 100);
      })
    );

    this.subs.add(
      this.chatService.chatrooms$.subscribe(rooms => {
        this.chatrooms = rooms;
        if (this.activeChat !== 'global' && !this.openDMs.includes(this.activeChat) && !rooms.find(r => r.id === this.activeChat)) {
          this.activeChat = 'global';
        }
      })
    );

    let previousRoomMsgCount = 0;
    this.subs.add(
      this.chatService.roomMessages$.subscribe(msgs => {
        const newMsgs = msgs.slice(previousRoomMsgCount);
        previousRoomMsgCount = msgs.length;
        this.roomMessages = msgs;

        newMsgs.forEach(m => {
          if (m.roomId !== this.activeChat && m.user !== this.currentUser) {
            this.unreadRooms.add(m.roomId);
          }
        });

        setTimeout(() => {
          const scrollable = document.querySelector('.custom-scrollbar');
          if (scrollable) {
            scrollable.scrollTop = scrollable.scrollHeight;
          }
        }, 100);
      })
    );

    this.subs.add(
      this.chatService.onlineUsers$.subscribe(users => this.onlineUsers = users)
    );

    // Study Rooms Subscriptions
    this.subs.add(
      this.studyRoomService.studyRooms$.subscribe(rooms => {
        this.studyRooms = rooms;
        if (this.activeChat !== 'global' && !this.openDMs.includes(this.activeChat) && 
            !this.chatrooms.find(r => r.id === this.activeChat) &&
            !rooms.find(r => r.id === this.activeChat)) {
          this.activeChat = 'global';
        }
      })
    );

    let previousStudyMsgCount = 0;
    this.subs.add(
      this.studyRoomService.studyRoomMessages$.subscribe(msgs => {
        const newMsgs = msgs.slice(previousStudyMsgCount);
        previousStudyMsgCount = msgs.length;
        this.studyRoomMessages = msgs;

        newMsgs.forEach(m => {
          if (m.roomId !== this.activeChat && m.user !== this.currentUser) {
            this.unreadStudyRooms.add(m.roomId);
          }
        });

        setTimeout(() => {
          const scrollable = document.querySelector('.custom-scrollbar');
          if (scrollable) {
            scrollable.scrollTop = scrollable.scrollHeight;
          }
        }, 100);
      })
    );

    this.subs.add(
      this.studyRoomService.pendingInvites$.subscribe(invites => this.pendingInvites = invites)
    );

    this.subs.add(
      this.studyRoomService.pinguTyping$.subscribe(map => this.pinguTypingMap = map)
    );

    this.timerInterval = setInterval(() => {
      // Force UI update for countdown timers
    }, 1000);

    this.subs.add(
      this.chatService.userLeft$.subscribe(user => {
        if (!user) return;
        this.openDMs = this.openDMs.filter(dm => dm !== user);
        this.unreadDMs.delete(user);
        if (this.activeChat === user) {
          this.activeChat = 'global';
        }
      })
    );
  }

  ngOnDestroy() {
    this.subs.unsubscribe();
    if (this.timerInterval) clearInterval(this.timerInterval);
  }

  async sendMessage(event?: Event) {
    if (event) {
      event.preventDefault();
    }

    if (!this.newMessage.trim() && this.selectedFiles.length === 0) return;

    const msg = this.newMessage;
    const reply = this.replyingTo || undefined;

    // Send files first
    if (this.selectedFiles.length > 0) {
      for (let i = 0; i < this.selectedFiles.length; i++) {
        const fileObj = this.selectedFiles[i];
        // Send caption only with the first file or all? Let's say first one if it's a "batch" or just first one.
        // Usually, message + multiple files are separate.
        // User said "file and a message to be sent together where the message can act as a caption".
        // We'll send the caption with the first file and clear it, or send it with all?
        // Let's send the caption with the first file and then empty strings for others if multiple.
        const caption = i === 0 ? msg : '';
        const target = this.activeChat === 'global' ? undefined : this.activeChat;
        if (this.activeRoom) {
          await this.chatService.sendRoomFile(this.activeRoom.id, fileObj.file, caption);
        } else {
          await this.chatService.sendFile(fileObj.file, target, caption);
        }
      }
    } else {
      // Send regular message
      if (this.activeChat === 'global') {
        await this.chatService.sendMessage(msg, reply);
      } else if (this.activeRoom) {
        await this.chatService.sendRoomMessage(this.activeRoom.id, msg, reply);
      } else if (this.activeStudyRoom) {
        await this.studyRoomService.sendMessage(this.activeStudyRoom.id, msg);
      } else {
        await this.chatService.sendPrivateMessage(this.activeChat, msg);
      }
    }

    this.newMessage = '';
    this.selectedFiles = [];
    this.replyingTo = null;
  }

  async onFileSelected(event: any) {
    const files = event.target.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();
      reader.onload = (e: any) => {
        this.selectedFiles.push({
          file: file,
          preview: e.target.result,
          type: file.type
        });
      };
      reader.readAsDataURL(file);
    }
    // Reset input
    event.target.value = '';
  }
}
