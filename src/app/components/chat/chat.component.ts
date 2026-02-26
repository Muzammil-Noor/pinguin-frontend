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

  private subs = new Subscription();

  constructor(private chatService: ChatService, private router: Router) {
    this.currentUser = this.chatService.currentUser;
  }

  get filteredMessages(): ChatMessage[] {
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
  }

  ngOnDestroy() {
    this.subs.unsubscribe();
  }

  async sendMessage(event?: Event) {
    if (event) {
      event.preventDefault(); // Prevent newline in textarea on enter
    }

    if (!this.newMessage.trim()) return;

    const msg = this.newMessage;
    this.newMessage = ''; // clear early

    if (this.activeChat === 'global') {
      await this.chatService.sendMessage(msg);
    } else {
      await this.chatService.sendPrivateMessage(this.activeChat, msg);
    }
  }

  async onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      const target = this.activeChat === 'global' ? undefined : this.activeChat;
      await this.chatService.sendFile(file, target);
      // Reset input
      event.target.value = '';
    }
  }
}
