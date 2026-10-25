import { randomUUID } from "node:crypto";
import type { Activity, ScreenshotInfo } from "../shared/contracts";

const RECENT_LIMIT = 25;

export class PanelState {
  private last: { info: ScreenshotInfo; jpeg: Buffer } | null = null;
  private recent: Activity[] = [];

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  screenshot(agentId: string, jpeg: Buffer, width: number, height: number): void {
    this.last = { info: { id: randomUUID(), agentId, width, height, time: this.now() }, jpeg };
  }

  activity(entry: Omit<Activity, "time">): void {
    this.recent = [{ time: this.now(), ...entry }, ...this.recent].slice(0, RECENT_LIMIT);
  }

  image(id: string): { id: string; jpegBase64: string } {
    if (this.last === null) throw new Error(`Screenshot ${id} is no longer kept; the plugin restarted since it was taken`);
    if (this.last.info.id !== id) throw new Error(`Screenshot ${id} was replaced by a newer one`);
    return { id, jpegBase64: this.last.jpeg.toString("base64") };
  }

  snapshot(): { screenshot: ScreenshotInfo | null; recent: Activity[] } {
    return { screenshot: this.last?.info ?? null, recent: [...this.recent] };
  }
}
