import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { ChatService } from './chat.service';

/**
 * Logical canvas size. Every client draws into a backing store of exactly these dimensions
 * and scales it with CSS, so a given op lands on identical pixels everywhere. That matters
 * most for fill: a flood fill computed against a different resolution would spread
 * differently and the boards would diverge.
 */
export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 900;

/** How often an in-progress stroke is relayed to peers while the pointer is still down. */
const LIVE_STREAM_INTERVAL = 60;

export type WhiteboardTool = 'brush' | 'line' | 'rect' | 'ellipse' | 'fill';

/** Payload keys are terse -- these travel on every stroke and count against the 64KB op cap. */
export type WhiteboardPayload =
  | { t: 'stroke'; sid: string; c: string; w: number; p: number[] }
  | { t: 'shape'; sid: string; s: 'line' | 'rect' | 'ellipse'; c: string; w: number; x0: number; y0: number; x1: number; y1: number }
  | { t: 'fill'; sid: string; c: string; x: number; y: number };

export interface WhiteboardOp {
  id: string;
  seq: number;
  author: string;
  payload: WhiteboardPayload;
  hidden: boolean;
}

export type LiveMeta = { c: string; w: number; s?: 'line' | 'rect' | 'ellipse' };

export interface LiveStroke {
  author: string;
  /** `s` marks a shape preview, whose points are a replaceable [x0,y0,x1,y1] rather than a path. */
  meta: LiveMeta;
  points: number[];
}

export type WhiteboardChange =
  | { type: 'reset' }
  | { type: 'op'; op: WhiteboardOp; outOfOrder: boolean; alreadyDrawn: boolean }
  | { type: 'visibility' }
  | { type: 'cleared'; by: string }
  | { type: 'live' }
  | { type: 'rejected'; reason: string }
  | { type: 'rateLimited'; retryInSeconds: number };

@Injectable({ providedIn: 'root' })
export class WhiteboardService {
  /** Committed ops in server sequence order. Hidden ones are kept so redo can restore them. */
  public ops: WhiteboardOp[] = [];

  /** In-progress strokes from other people, keyed by stroke id. Preview only, never logged. */
  public remoteLive = new Map<string, LiveStroke>();

  /** Local ops already painted before the server echoed them back. */
  private optimisticSids = new Set<string>();

  public changes$ = new Subject<WhiteboardChange>();

  private roomId: string | null = null;
  private lastStreamAt = 0;
  private streamedUpTo = new Map<string, number>();

  constructor(private chatService: ChatService) {
    this.setupListeners();
  }

  private get hub() {
    return this.chatService['hubConnection'];
  }

  public get currentUser(): string {
    return this.chatService.currentUser;
  }

  // =========================
  // LIFECYCLE
  // =========================

  /** Loads the board for a room. Pulls the full log so a late joiner sees existing work. */
  public async open(roomId: string): Promise<void> {
    this.roomId = roomId;
    this.ops = [];
    this.remoteLive.clear();
    this.optimisticSids.clear();
    this.streamedUpTo.clear();

    const state = await this.hub.invoke<{ ops: WhiteboardOp[] }>('GetWhiteboardState', roomId);
    this.ops = (state?.ops ?? []).slice().sort((a, b) => a.seq - b.seq);
    this.changes$.next({ type: 'reset' });
  }

  public close() {
    this.roomId = null;
    this.remoteLive.clear();
  }

  public get visibleOps(): WhiteboardOp[] {
    return this.ops.filter(o => !o.hidden);
  }

  /** True when this user has anything left to undo -- drives the toolbar's disabled state. */
  public get canUndo(): boolean {
    return this.ops.some(o => !o.hidden && o.author === this.currentUser);
  }

  // =========================
  // LISTENERS
  // =========================

  private setupListeners() {
    this.hub.on('WhiteboardEvent', (roomId: string, op: WhiteboardOp) => {
      if (roomId !== this.roomId) return;

      // A preview for this stroke is now superseded by the committed geometry.
      this.remoteLive.delete(op.payload.sid);

      const alreadyDrawn = this.optimisticSids.delete(op.payload.sid);
      const highestSeq = this.ops.length ? this.ops[this.ops.length - 1].seq : -1;

      // Someone else's op won the race and was ordered before ours. Our optimistic paint used
      // the wrong order, so the whole board has to be rebuilt from the corrected log.
      const outOfOrder = op.seq < highestSeq;

      this.ops.push(op);
      if (outOfOrder) this.ops.sort((a, b) => a.seq - b.seq);

      this.changes$.next({ type: 'op', op, outOfOrder, alreadyDrawn });
    });

    this.hub.on('WhiteboardLive', (roomId: string, strokeId: string, author: string, meta: any, points: number[]) => {
      if (roomId !== this.roomId || author === this.currentUser) return;

      const existing = this.remoteLive.get(strokeId);

      // Freehand arrives as deltas and accumulates; a shape is only ever two corners, and
      // each update supersedes the last as the pointer is dragged.
      if (existing && !meta.s) {
        existing.points.push(...points);
      } else {
        this.remoteLive.set(strokeId, { author, meta, points: [...points] });
      }

      this.changes$.next({ type: 'live' });
    });

    this.hub.on('WhiteboardLiveEnd', (roomId: string, strokeId: string) => {
      if (roomId !== this.roomId) return;
      if (this.remoteLive.delete(strokeId)) this.changes$.next({ type: 'live' });
    });

    this.hub.on('WhiteboardUndo', (roomId: string, opId: string) => {
      if (roomId !== this.roomId) return;
      this.setHidden(opId, true);
    });

    this.hub.on('WhiteboardRedo', (roomId: string, opId: string) => {
      if (roomId !== this.roomId) return;
      this.setHidden(opId, false);
    });

    this.hub.on('WhiteboardCleared', (roomId: string, by: string) => {
      if (roomId !== this.roomId) return;
      this.ops = [];
      this.remoteLive.clear();
      this.optimisticSids.clear();
      this.changes$.next({ type: 'cleared', by });
    });

    this.hub.on('WhiteboardRejected', (roomId: string, reason: string) => {
      if (roomId !== this.roomId) return;
      this.changes$.next({ type: 'rejected', reason });
    });

    this.hub.on('RateLimitExceeded', (scope: string, retryInSeconds: number) => {
      if (scope !== 'whiteboard') return;
      this.changes$.next({ type: 'rateLimited', retryInSeconds });
    });
  }

  private setHidden(opId: string, hidden: boolean) {
    const op = this.ops.find(o => o.id === opId);
    if (!op || op.hidden === hidden) return;

    op.hidden = hidden;
    // Hiding an op changes the pixels every later op was drawn on top of, so the board is
    // rebuilt rather than patched.
    this.changes$.next({ type: 'visibility' });
  }

  // =========================
  // OUTBOUND
  // =========================

  public newStrokeId(): string {
    return Math.random().toString(36).slice(2, 11);
  }

  /**
   * Commits a finished op. Callers paint it locally first and pass painted=true, so the echo
   * from the server is recorded without repainting.
   */
  public commit(payload: WhiteboardPayload, painted: boolean) {
    if (!this.roomId) return;

    if (painted) this.optimisticSids.add(payload.sid);
    this.streamedUpTo.delete(payload.sid);

    this.hub.invoke('SendWhiteboardAction', this.roomId, payload).catch(() => {
      // Delivery failed, so no echo is coming; drop the optimistic marker to keep the
      // next replay honest.
      this.optimisticSids.delete(payload.sid);
    });
  }

  /**
   * Relays the part of an in-progress stroke peers have not seen yet. Throttled, and sends
   * only the new points rather than the whole path.
   */
  public streamStroke(strokeId: string, meta: LiveMeta, allPoints: number[], force = false) {
    if (!this.roomId) return;

    const now = Date.now();
    if (!force && now - this.lastStreamAt < LIVE_STREAM_INTERVAL) return;

    // A shape sends its two corners in full every time; only freehand has a growing tail
    // worth diffing.
    if (meta.s) {
      this.lastStreamAt = now;
      this.hub.invoke('StreamWhiteboardStroke', this.roomId, strokeId, meta, allPoints).catch(() => { });
      return;
    }

    const sentUpTo = this.streamedUpTo.get(strokeId) ?? 0;
    if (allPoints.length <= sentUpTo) return;

    const delta = allPoints.slice(sentUpTo);
    this.streamedUpTo.set(strokeId, allPoints.length);
    this.lastStreamAt = now;

    this.hub.invoke('StreamWhiteboardStroke', this.roomId, strokeId, meta, delta).catch(() => { });
  }

  /** Tells peers to drop a preview that will never be committed. */
  public cancelStroke(strokeId: string) {
    if (!this.roomId) return;
    this.streamedUpTo.delete(strokeId);
    this.hub.invoke('CancelWhiteboardStroke', this.roomId, strokeId).catch(() => { });
  }

  public undo() {
    if (this.roomId) this.hub.invoke('UndoWhiteboard', this.roomId).catch(() => { });
  }

  public redo() {
    if (this.roomId) this.hub.invoke('RedoWhiteboard', this.roomId).catch(() => { });
  }

  public clear() {
    if (this.roomId) this.hub.invoke('ClearWhiteboard', this.roomId).catch(() => { });
  }
}
