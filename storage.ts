import { type User, type InsertUser } from "@shared/schema";
import { randomUUID } from "crypto";

export interface MacroNote {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  pinned: boolean;
  keywords: string[];
}

export interface SignalHistory {
  date: string;
  theme: string;
  level: "HOT" | "WARM" | "COOL";
  score: number;
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getNotes(): Promise<MacroNote[]>;
  createNote(note: Omit<MacroNote, "id">): Promise<MacroNote>;
  updateNote(id: string, updates: Partial<MacroNote>): Promise<MacroNote | undefined>;
  deleteNote(id: string): Promise<boolean>;
  getSignalHistory(): Promise<SignalHistory[]>;
  addSignalHistory(signal: SignalHistory): Promise<void>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private notes: Map<string, MacroNote>;
  private signalHistory: SignalHistory[];

  constructor() {
    this.users = new Map();
    this.notes = new Map();
    this.signalHistory = [];
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async getNotes(): Promise<MacroNote[]> {
    return Array.from(this.notes.values());
  }

  async createNote(note: Omit<MacroNote, "id">): Promise<MacroNote> {
    const id = randomUUID();
    const newNote: MacroNote = { ...note, id };
    this.notes.set(id, newNote);
    return newNote;
  }

  async updateNote(id: string, updates: Partial<MacroNote>): Promise<MacroNote | undefined> {
    const note = this.notes.get(id);
    if (!note) return undefined;
    const updated = { ...note, ...updates };
    this.notes.set(id, updated);
    return updated;
  }

  async deleteNote(id: string): Promise<boolean> {
    return this.notes.delete(id);
  }

  async getSignalHistory(): Promise<SignalHistory[]> {
    const { readFileSync, writeFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const historyPath = join(process.cwd(), "data", "signal_history.json");

    if (existsSync(historyPath)) {
      const history = JSON.parse(readFileSync(historyPath, "utf-8"));
      // Deduplicate: keep only the last entry for each theme+date combination
      const seen = new Map<string, SignalHistory>();
      for (const signal of history) {
        const key = `${signal.date}:${signal.theme}`;
        seen.set(key, signal);
      }
      const deduplicated = Array.from(seen.values());

      // Write back deduplicated version if there were duplicates
      if (deduplicated.length < history.length) {
        writeFileSync(historyPath, JSON.stringify(deduplicated, null, 2));
      }

      return deduplicated;
    }
    return [];
  }

  async addSignalHistory(signal: SignalHistory): Promise<void> {
    const { readFileSync, writeFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const historyPath = join(process.cwd(), "data", "signal_history.json");

    let history: SignalHistory[] = [];
    if (existsSync(historyPath)) {
      history = JSON.parse(readFileSync(historyPath, "utf-8"));
    }

    // Check if signal already exists for this theme on this date
    const exists = history.some(h => h.date === signal.date && h.theme === signal.theme);
    if (!exists) {
      history.push(signal);
      writeFileSync(historyPath, JSON.stringify(history, null, 2));
    }
  }
}

export const storage = new MemStorage();
