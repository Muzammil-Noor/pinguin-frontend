import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../services/chat.service';
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
  messages: { user: string, message: string }[] = [];
  onlineUsers: string[] = [];
  currentUser: string = '';
  newMessage: string = '';

  private subs = new Subscription();

  constructor(private chatService: ChatService, private router: Router) {
    this.currentUser = this.chatService.currentUser;
  }

  ngOnInit() {
    if (!this.currentUser) {
      this.router.navigate(['/']);
      return;
    }

    this.subs.add(
      this.chatService.messages$.subscribe(msgs => this.messages = msgs)
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

    await this.chatService.sendMessage(this.newMessage);
    this.newMessage = '';
  }
}
