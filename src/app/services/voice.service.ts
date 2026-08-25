import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { ChatService } from './chat.service';

// STUN alone resolves most NATs but not symmetric ones; a deployment that needs to work
// everywhere has to add a TURN server here.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];

export interface VoiceParticipant {
  username: string;
  speaking: boolean;
  state: RTCPeerConnectionState | 'new';
}

export type VoiceJoinResult = { ok: true } | { ok: false; reason: string; capacity?: number };

@Injectable({ providedIn: 'root' })
export class VoiceService {
  public joinedRoom$ = new BehaviorSubject<string | null>(null);
  public participants$ = new BehaviorSubject<VoiceParticipant[]>([]);
  public talking$ = new BehaviorSubject<boolean>(false);
  public error$ = new Subject<string>();

  public capacity = 0;

  private roomId: string | null = null;
  private localStream: MediaStream | null = null;

  private peers = new Map<string, RTCPeerConnection>();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private audio = new Map<string, HTMLAudioElement>();

  constructor(private chatService: ChatService, private zone: NgZone) {
    this.setupListeners();
  }

  private get hub() {
    return this.chatService['hubConnection'];
  }

  public get isJoined(): boolean {
    return this.roomId !== null;
  }

  // =========================
  // JOIN / LEAVE
  // =========================

  public async join(roomId: string): Promise<VoiceJoinResult> {
    if (this.roomId) return { ok: false, reason: 'alreadyJoined' };

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (err: any) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      return { ok: false, reason: denied ? 'micDenied' : 'micUnavailable' };
    }

    // Push-to-talk: the track is present from the start so peers have something to
    // negotiate, but it stays silent until the key goes down.
    this.setTrackEnabled(false);

    let result: any;
    try {
      result = await this.hub.invoke('JoinVoice', roomId);
    } catch {
      this.stopLocalStream();
      return { ok: false, reason: 'failed' };
    }

    if (!result?.ok) {
      this.stopLocalStream();
      return { ok: false, reason: result?.reason ?? 'failed', capacity: result?.capacity };
    }

    this.roomId = roomId;
    this.capacity = result.capacity ?? 0;
    this.joinedRoom$.next(roomId);

    const alreadySpeaking = new Set<string>(result.speaking ?? []);

    // Only the newcomer offers. If both sides offered we would collide mid-negotiation.
    for (const peer of (result.participants ?? []) as string[]) {
      this.upsertParticipant(peer, alreadySpeaking.has(peer));
      try {
        await this.createPeer(peer, true);
      } catch {
        this.error$.next(`Could not reach ${peer}`);
      }
    }

    return { ok: true };
  }

  public async leave(): Promise<void> {
    const roomId = this.roomId;
    if (!roomId) return;

    this.stopTalking();
    this.roomId = null;

    for (const username of Array.from(this.peers.keys())) this.teardownPeer(username);

    this.stopLocalStream();
    this.participants$.next([]);
    this.joinedRoom$.next(null);

    try {
      await this.hub.invoke('LeaveVoice', roomId);
    } catch { }
  }

  // =========================
  // PUSH TO TALK
  // =========================

  public startTalking() {
    if (!this.roomId || this.talking$.value) return;

    this.talking$.next(true);
    this.setTrackEnabled(true);
    this.hub.invoke('PushToTalkStart', this.roomId).catch(() => { });
  }

  public stopTalking() {
    if (!this.roomId || !this.talking$.value) return;

    this.talking$.next(false);
    this.setTrackEnabled(false);
    this.hub.invoke('PushToTalkStop', this.roomId).catch(() => { });
  }

  private setTrackEnabled(enabled: boolean) {
    this.localStream?.getAudioTracks().forEach(track => (track.enabled = enabled));
  }

  // =========================
  // MESH
  // =========================

  private async createPeer(username: string, initiator: boolean): Promise<RTCPeerConnection> {
    const existing = this.peers.get(username);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(username, pc);

    for (const track of this.localStream!.getTracks()) {
      pc.addTrack(track, this.localStream!);
    }

    pc.onicecandidate = e => {
      if (e.candidate) this.signal(username, { kind: 'ice', candidate: e.candidate.toJSON() });
    };

    // RTC callbacks are not reliably inside Angular's zone, so anything that drives the
    // view is re-entered explicitly.
    pc.ontrack = e => this.zone.run(() => this.attachAudio(username, e.streams[0]));

    pc.onconnectionstatechange = () => {
      this.zone.run(() => {
        this.upsertParticipant(username, undefined, pc.connectionState);
        if (pc.connectionState === 'failed') {
          this.error$.next(`Lost the connection to ${username}`);
        }
      });
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal(username, { kind: 'offer', sdp: pc.localDescription });
    }

    return pc;
  }

  private teardownPeer(username: string) {
    const pc = this.peers.get(username);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      this.peers.delete(username);
    }

    this.pendingIce.delete(username);

    const el = this.audio.get(username);
    if (el) {
      el.pause();
      el.srcObject = null;
      el.remove();
      this.audio.delete(username);
    }

    this.participants$.next(this.participants$.value.filter(p => p.username !== username));
  }

  private attachAudio(username: string, stream: MediaStream) {
    let el = this.audio.get(username);

    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      this.audio.set(username, el);
    }

    el.srcObject = stream;
    el.play().catch(() => { });
  }

  private signal(target: string, payload: unknown) {
    if (!this.roomId) return;
    this.hub.invoke('SendVoiceSignal', this.roomId, target, payload).catch(() => { });
  }

  private async drainIce(username: string, pc: RTCPeerConnection) {
    const queued = this.pendingIce.get(username);
    if (!queued) return;

    this.pendingIce.delete(username);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch { }
    }
  }

  private stopLocalStream() {
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = null;
  }

  // =========================
  // LISTENERS
  // =========================

  private setupListeners() {
    this.hub.on('VoiceParticipantJoined', (roomId: string, username: string) => {
      if (roomId !== this.roomId) return;
      // They will offer to us; we only reserve their slot in the list.
      this.upsertParticipant(username, false);
    });

    this.hub.on('VoiceParticipantLeft', (roomId: string, username: string) => {
      if (roomId !== this.roomId) return;
      this.teardownPeer(username);
    });

    this.hub.on('SpeakingIndicator', (roomId: string, username: string, isSpeaking: boolean) => {
      if (roomId !== this.roomId) return;
      this.upsertParticipant(username, isSpeaking);
    });

    this.hub.on('VoiceSignal', async (roomId: string, from: string, signal: any) => {
      if (roomId !== this.roomId || !this.localStream) return;

      try {
        if (signal.kind === 'offer') {
          const pc = await this.createPeer(from, false);
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          await this.drainIce(from, pc);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.signal(from, { kind: 'answer', sdp: pc.localDescription });

          this.upsertParticipant(from);
          return;
        }

        if (signal.kind === 'answer') {
          const pc = this.peers.get(from);
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          await this.drainIce(from, pc);
          return;
        }

        if (signal.kind === 'ice') {
          const pc = this.peers.get(from);

          // Candidates routinely arrive before the description they belong to, and
          // addIceCandidate throws if there is no remote description yet.
          if (pc?.remoteDescription) {
            await pc.addIceCandidate(signal.candidate);
          } else {
            const queued = this.pendingIce.get(from) ?? [];
            queued.push(signal.candidate);
            this.pendingIce.set(from, queued);
          }
        }
      } catch (err) {
        console.error('voice signal failed', err);
      }
    });

    // A peer who drops off the app entirely never sends LeaveVoice.
    this.chatService.userLeft$.subscribe(username => {
      if (username && this.peers.has(username)) this.teardownPeer(username);
    });
  }

  private upsertParticipant(username: string, speaking?: boolean, state?: RTCPeerConnectionState) {
    const list = this.participants$.value;
    const existing = list.find(p => p.username === username);

    if (!existing) {
      this.participants$.next([...list, {
        username,
        speaking: speaking ?? false,
        state: state ?? 'new'
      }]);
      return;
    }

    this.participants$.next(list.map(p => p.username !== username ? p : {
      ...p,
      speaking: speaking ?? p.speaking,
      state: state ?? p.state
    }));
  }
}
