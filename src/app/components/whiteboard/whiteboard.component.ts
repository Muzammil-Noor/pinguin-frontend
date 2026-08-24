import { Component, ElementRef, Input, OnDestroy, AfterViewInit, ViewChild, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  WhiteboardService, WhiteboardTool, WhiteboardPayload,
  BOARD_WIDTH, BOARD_HEIGHT
} from '../../services/whiteboard.service';
import { renderOp, drawStroke, drawShape, paintBackground } from '../../services/whiteboard-render';

/**
 * Points per committed stroke. A stroke is one op and the server caps an op payload at 64KB,
 * so a long unbroken drag is split into several ops that join end to end.
 */
const MAX_POINTS_PER_STROKE = 2500;

@Component({
  selector: 'app-whiteboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './whiteboard.component.html',
  styleUrl: './whiteboard.component.css'
})
export class WhiteboardComponent implements AfterViewInit, OnDestroy {
  @Input() roomId!: string;

  @ViewChild('baseCanvas') baseRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('liveCanvas') liveRef!: ElementRef<HTMLCanvasElement>;

  readonly boardWidth = BOARD_WIDTH;
  readonly boardHeight = BOARD_HEIGHT;

  tool: WhiteboardTool = 'brush';
  color = '#ffffff';
  strokeWidth = 4;
  notice = '';

  /**
   * Mirrors the service's undo availability as a plain field. A getter here would be
   * re-evaluated on every change detection pass and would rescan the whole op log.
   */
  canUndo = false;

  readonly swatches = [
    '#ffffff', '#c51ce9', '#4075f9', '#22d3ee',
    '#34d399', '#fbbf24', '#f97316', '#ef4444',
    '#ec4899', '#a78bfa', '#94a3b8', '#101018'
  ];

  private baseCtx!: CanvasRenderingContext2D;
  private liveCtx!: CanvasRenderingContext2D;

  private drawing = false;
  private activeSid: string | null = null;
  private points: number[] = [];
  private shapeStart: { x: number; y: number } | null = null;
  private shapeEnd: { x: number; y: number } | null = null;

  private liveDirty = true;
  private raf = 0;
  private sub = new Subscription();
  private noticeTimer: any;

  constructor(public board: WhiteboardService, private zone: NgZone) { }

  // =========================
  // LIFECYCLE
  // =========================

  async ngAfterViewInit() {
    // willReadFrequently: the fill tool round-trips through getImageData, and without this
    // hint browsers keep the canvas GPU-backed and every read stalls on a readback.
    this.baseCtx = this.baseRef.nativeElement.getContext('2d', { willReadFrequently: true })!;
    this.liveCtx = this.liveRef.nativeElement.getContext('2d')!;

    this.sub.add(this.board.changes$.subscribe(change => {
      this.canUndo = this.board.canUndo;

      switch (change.type) {
        case 'reset':
        case 'visibility':
          this.replay();
          break;

        case 'cleared':
          this.replay();
          this.flash(change.by === this.board.currentUser ? 'Board cleared' : `${change.by} cleared the board`);
          break;

        case 'op':
          // Out of order means our optimistic paint used the wrong layering, so rebuild.
          // Already drawn means this is the echo of our own op and the pixels are correct.
          if (change.outOfOrder) this.replay();
          else if (!change.alreadyDrawn) renderOp(this.baseCtx, change.op.payload);
          this.liveDirty = true;
          break;

        case 'live':
          this.liveDirty = true;
          break;

        case 'rejected':
          this.flash(change.reason === 'BoardFull'
            ? 'Board is full - clear it to keep drawing'
            : 'That was too large to send');
          this.replay();
          break;

        case 'rateLimited':
          this.flash(`Slow down - drawing again in ${change.retryInSeconds}s`);
          this.replay();
          break;
      }
    }));

    await this.board.open(this.roomId);

    // Everything below drives pixels, not the Angular view. zone.js patches both
    // requestAnimationFrame and pointer events, so left inside the zone this would run a full
    // change detection pass every frame and again on every pointer sample -- which is exactly
    // the lag a drawing surface cannot afford.
    this.zone.runOutsideAngular(() => {
      const canvas = this.liveRef.nativeElement;
      canvas.addEventListener('pointerdown', this.handlePointerDown);
      canvas.addEventListener('pointermove', this.handlePointerMove);
      canvas.addEventListener('pointerup', this.handlePointerUp);
      canvas.addEventListener('pointercancel', this.handlePointerCancel);
      this.loop();
    });
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.noticeTimer);

    const canvas = this.liveRef?.nativeElement;
    if (canvas) {
      canvas.removeEventListener('pointerdown', this.handlePointerDown);
      canvas.removeEventListener('pointermove', this.handlePointerMove);
      canvas.removeEventListener('pointerup', this.handlePointerUp);
      canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    }

    this.sub.unsubscribe();
    this.board.close();
  }

  private loop = () => {
    if (this.liveDirty) {
      this.renderLive();
      this.liveDirty = false;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  // =========================
  // RENDERING
  // =========================

  /** Rebuilds the committed layer from the op log. */
  private replay() {
    if (!this.baseCtx) return;

    paintBackground(this.baseCtx);
    for (const op of this.board.visibleOps) renderOp(this.baseCtx, op.payload);
  }

  /** Everything still in flight: our current stroke plus previews from other people. */
  private renderLive() {
    const ctx = this.liveCtx;
    ctx.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

    this.board.remoteLive.forEach(stroke => {
      if (stroke.meta.s && stroke.points.length >= 4) {
        drawShape(ctx, {
          s: stroke.meta.s,
          c: stroke.meta.c,
          w: stroke.meta.w,
          x0: stroke.points[0], y0: stroke.points[1],
          x1: stroke.points[2], y1: stroke.points[3]
        });
      } else {
        drawStroke(ctx, stroke.meta.c, stroke.meta.w, stroke.points);
      }
    });

    if (!this.drawing) return;

    if (this.tool === 'brush') {
      drawStroke(ctx, this.color, this.strokeWidth, this.points);
    } else if (this.shapeStart && this.shapeEnd) {
      drawShape(ctx, {
        s: this.tool as 'line' | 'rect' | 'ellipse',
        c: this.color,
        w: this.strokeWidth,
        x0: this.shapeStart.x, y0: this.shapeStart.y,
        x1: this.shapeEnd.x, y1: this.shapeEnd.y
      });
    }
  }

  // =========================
  // POINTER INPUT
  // =========================

  /**
   * Screen coordinates to board coordinates. The backing store is a fixed size and CSS scales
   * it, so this divides out whatever size the element happens to be on screen.
   */
  private toBoard(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.liveRef.nativeElement.getBoundingClientRect();
    return {
      // Rounded to one decimal: enough precision to draw smoothly, and it keeps the
      // serialised payload well clear of the per-op size cap.
      x: Math.round((e.clientX - rect.left) / rect.width * BOARD_WIDTH * 10) / 10,
      y: Math.round((e.clientY - rect.top) / rect.height * BOARD_HEIGHT * 10) / 10
    };
  }

  private handlePointerDown = (e: PointerEvent) => this.onPointerDown(e);
  private handlePointerMove = (e: PointerEvent) => this.onPointerMove(e);
  private handlePointerUp = (e: PointerEvent) => this.onPointerUp(e);
  private handlePointerCancel = () => this.onPointerCancel();

  onPointerDown(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    this.liveRef.nativeElement.setPointerCapture(e.pointerId);
    const pt = this.toBoard(e);

    if (this.tool === 'fill') {
      // A fill is a click, not a drag -- commit it straight away.
      this.commitPayload({ t: 'fill', sid: this.board.newStrokeId(), c: this.color, x: pt.x, y: pt.y });
      return;
    }

    this.drawing = true;
    this.activeSid = this.board.newStrokeId();

    if (this.tool === 'brush') {
      this.points = [pt.x, pt.y];
    } else {
      this.shapeStart = pt;
      this.shapeEnd = pt;
    }

    this.liveDirty = true;
  }

  onPointerMove(e: PointerEvent) {
    if (!this.drawing) return;

    if (this.tool === 'brush') {
      // Coalesced events recover the input samples the browser batched into this one frame,
      // so fast strokes stay smooth instead of turning into long straight segments.
      const batch: PointerEvent[] = typeof e.getCoalescedEvents === 'function'
        ? e.getCoalescedEvents()
        : [e];

      for (const sample of batch) {
        const pt = this.toBoard(sample);
        this.points.push(pt.x, pt.y);
      }

      if (this.points.length >= MAX_POINTS_PER_STROKE * 2) this.splitStroke();

      this.board.streamStroke(this.activeSid!, { c: this.color, w: this.strokeWidth }, this.points);
    } else {
      this.shapeEnd = this.toBoard(e);
      this.board.streamStroke(
        this.activeSid!,
        { c: this.color, w: this.strokeWidth, s: this.tool as 'line' | 'rect' | 'ellipse' },
        [this.shapeStart!.x, this.shapeStart!.y, this.shapeEnd.x, this.shapeEnd.y]
      );
    }

    this.liveDirty = true;
  }

  onPointerUp(e: PointerEvent) {
    if (!this.drawing) return;

    this.liveRef.nativeElement.releasePointerCapture?.(e.pointerId);

    if (this.tool === 'brush') {
      if (this.points.length >= 2) {
        this.commitPayload({
          t: 'stroke', sid: this.activeSid!, c: this.color, w: this.strokeWidth, p: this.points
        });
      }
    } else if (this.shapeStart && this.shapeEnd) {
      this.commitPayload({
        t: 'shape', sid: this.activeSid!, s: this.tool as 'line' | 'rect' | 'ellipse',
        c: this.color, w: this.strokeWidth,
        x0: this.shapeStart.x, y0: this.shapeStart.y,
        x1: this.shapeEnd.x, y1: this.shapeEnd.y
      });
    }

    this.endStroke();
  }

  onPointerCancel() {
    if (!this.drawing) return;
    if (this.activeSid) this.board.cancelStroke(this.activeSid);
    this.endStroke();
  }

  private endStroke() {
    this.drawing = false;
    this.activeSid = null;
    this.points = [];
    this.shapeStart = null;
    this.shapeEnd = null;
    this.liveDirty = true;
  }

  /**
   * Closes off the current stroke mid-drag when it grows past the per-op cap and starts a new
   * one from the same point, so a long continuous drag stays visually unbroken.
   */
  private splitStroke() {
    const lastX = this.points[this.points.length - 2];
    const lastY = this.points[this.points.length - 1];

    this.commitPayload({
      t: 'stroke', sid: this.activeSid!, c: this.color, w: this.strokeWidth, p: this.points
    });

    this.activeSid = this.board.newStrokeId();
    this.points = [lastX, lastY];
  }

  /** Paints locally first, then sends. The pixels never wait on the network. */
  private commitPayload(payload: WhiteboardPayload) {
    renderOp(this.baseCtx, payload);
    this.board.commit(payload, true);

    // Committed from outside the zone, so light up the undo button explicitly rather than
    // waiting for the server echo to bring change detection with it.
    if (!this.canUndo) this.zone.run(() => (this.canUndo = true));
  }

  // =========================
  // TOOLBAR
  // =========================

  setTool(tool: WhiteboardTool) {
    this.tool = tool;
  }

  undo() {
    this.board.undo();
  }

  redo() {
    this.board.redo();
  }

  clear() {
    this.board.clear();
  }

  exportPng() {
    const link = document.createElement('a');
    link.download = `pinguin-whiteboard-${Date.now()}.png`;
    link.href = this.baseRef.nativeElement.toDataURL('image/png');
    link.click();
  }

  private flash(message: string) {
    this.zone.run(() => {
      this.notice = message;
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => (this.notice = ''), 2600);
    });
  }
}
