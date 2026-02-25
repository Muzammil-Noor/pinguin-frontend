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

    const success = await this.chatService.startConnection(this.username);

    if (success) {
      this.router.navigate(['/chat']);
    } else {
      this.error = 'Username is taken or connection failed.';
      this.isLoading = false;
    }
  }
}
