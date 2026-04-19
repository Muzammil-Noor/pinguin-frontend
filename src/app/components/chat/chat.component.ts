import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService, ChatMessage } from '../../services/chat.service';
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

  replyingTo: ChatMessage | null = null;
  selectedFiles: { file: File, preview: string, type: string }[] = [];

  private subs = new Subscription();

  constructor(private chatService: ChatService, private router: Router) {
    this.currentUser = this.chatService.currentUser;
  }

  get filteredMessages(): ChatMessage[] {
    if (this.activeChat === 'global') {
      return this.messages.filter(m => !m.isPrivate);
    }
    return this.messages.filter(m => m.toUser === this.activeChat);
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
          if (m.isPrivate && m.toUser && m.toUser !== 'global') {
            if (!this.openDMs.includes(m.toUser) && m.toUser !== this.currentUser) {
              this.openDMs.push(m.toUser);
            }
            if (m.toUser !== this.activeChat && m.user !== this.currentUser) {
              this.unreadDMs.add(m.toUser);
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
      this.chatService.onlineUsers$.subscribe(users => this.onlineUsers = users)
    );

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
        await this.chatService.sendFile(fileObj.file, target, caption);
      }
    } else {
      // Send regular message
      if (this.activeChat === 'global') {
        await this.chatService.sendMessage(msg, reply);
      } else {
        await this.chatService.sendPrivateMessage(this.activeChat, msg); // Note: Private message reply logic not fully implemented in service yet
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
