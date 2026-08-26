import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { ChatService } from '../../services/chat.service';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent {
  username: string = '';
  error: string = '';
  isLoading: boolean = false;

  constructor(private chatService: ChatService, private router: Router) { }

  async join() {
    if (!this.username.trim()) {
      this.error = 'Username cannot be empty';
      return;
    }

    this.isLoading = true;
    this.error = '';

    const result = await this.chatService.startConnection(this.username);

    if (result === 'ok') {
      this.router.navigate(['/chat']);
    } else {
      this.error = this.describe(result);
      this.isLoading = false;
    }
  }

  private describe(reason: string): string {
    switch (reason) {
      case 'taken': return 'That username is taken.';
      case 'rateLimited': return 'Too many attempts - wait a minute and try again.';
      case 'challengeFailed': return 'Verification failed - please try again.';
      case 'invalid': return 'Usernames must be 1-32 characters.';
      default: return 'Could not connect to the server.';
    }
  }
}
