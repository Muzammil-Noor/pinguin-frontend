import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { VoiceService, VoiceParticipant } from '../../services/voice.service';
import { ChatService } from '../../services/chat.service';

const PTT_KEY = 'v';

@Component({
  selector: 'app-voice-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './voice-bar.component.html',
  styleUrl: './voice-bar.component.css'
})
export class VoiceBarComponent implements OnInit, OnDestroy {
  participants: VoiceParticipant[] = [];
  talking = false;
  currentUser = '';
  capacity = 0;

  readonly pttKey = PTT_KEY.toUpperCase();

  private subs = new Subscription();

  constructor(private voice: VoiceService, private chatService: ChatService) {
    this.currentUser = this.chatService.currentUser;
  }

  ngOnInit() {
    this.subs.add(this.voice.participants$.subscribe(p => {
      this.participants = p;
      this.capacity = this.voice.capacity;
    }));
    this.subs.add(this.voice.talking$.subscribe(t => (this.talking = t)));

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
  }

  ngOnDestroy() {
    this.subs.unsubscribe();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
  }

  get occupancy(): string {
    return `${this.participants.length + 1}/${this.capacity}`;
  }

  press() {
    this.voice.startTalking();
  }

  release() {
    this.voice.stopTalking();
  }

  leave() {
    this.voice.leave();
  }

  isConnecting(participant: VoiceParticipant): boolean {
    return participant.state !== 'connected' && participant.state !== 'failed';
  }

  isFailed(participant: VoiceParticipant): boolean {
    return participant.state === 'failed';
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Held keys autorepeat; only the first press should open the mic.
    if (e.repeat || e.key.toLowerCase() !== PTT_KEY) return;
    if (this.isTypingTarget(e.target)) return;

    e.preventDefault();
    this.voice.startTalking();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== PTT_KEY) return;
    this.voice.stopTalking();
  };

  // Tabbing away with the key held would otherwise leave the mic open indefinitely.
  private onWindowBlur = () => this.voice.stopTalking();

  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;

    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  }
}
