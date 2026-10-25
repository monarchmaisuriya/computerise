import type { Activity, LastScreenshot } from "../shared/contracts";

const RECENT_LIMIT = 25;

export class PanelState {
  private lastScreenshot: LastScreenshot | null = null;
  private recent: Activity[] = [];

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  screenshot(agentId: string, jpeg: Buffer, width: number, height: number): void {
    this.lastScreenshot = { agentId, jpegBase64: jpeg.toString("base64"), width, height, time: this.now() };
  }

  activity(entry: Omit<Activity, "time">): void {
    this.recent = [{ time: this.now(), ...entry }, ...this.recent].slice(0, RECENT_LIMIT);
  }

  snapshot(): { screenshot: LastScreenshot | null; recent: Activity[] } {
    return { screenshot: this.lastScreenshot, recent: [...this.recent] };
  }
}
