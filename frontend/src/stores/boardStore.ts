import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { pairBoards, boardUsable, swapOutOfTolerance } from '../utils/wood';
import type { BoardPart, BoardPair, PairReview, WoodBoard, WoodDefect, WoodGrain, WoodSpecies } from '../types/wood-board';

export interface BoardInput {
  boardNo: string;
  guqinNo: string;
  part: BoardPart;
  species: WoodSpecies;
  dryYears: number;
  thicknessMm: number;
  grain: WoodGrain;
  defect: WoodDefect;
  receivedAt?: string;
  remark?: string;
}

interface BoardState {
  boards: WoodBoard[];
  hydrated: boolean;
}

/** 板材与面板/底板配对 */
export const useBoardStore = defineStore('board', {
  state: (): BoardState => ({ boards: [], hydrated: false }),

  getters: {
    /** 面板与底板按琴号配对并回显含水率 */
    pairs(state): BoardPair[] {
      return pairBoards(state.boards);
    },
    /** 可用板材数（无裂纹且阴干达标） */
    usableCount(state): number {
      return state.boards.filter(boardUsable).length;
    },
    guqinNos(state): string[] {
      return Array.from(new Set(state.boards.map((b) => b.guqinNo).filter(Boolean))).sort();
    },
    /** 料库：未配琴的在库板材（含换料退下的旧板） */
    stockBoards(state): WoodBoard[] {
      return state.boards.filter((b) => !b.guqinNo);
    },
    boardsOf(state) {
      return (guqinNo: string): WoodBoard[] => state.boards.filter((b) => b.guqinNo === guqinNo);
    },
  },

  actions: {
    async hydrate() {
      this.boards = await db.boards.orderBy('boardNo').toArray();
      this.hydrated = true;
    },

    async addBoard(input: BoardInput): Promise<WoodBoard> {
      const board: WoodBoard = {
        id: uid('board'),
        boardNo: input.boardNo.trim(),
        guqinNo: input.guqinNo.trim(),
        part: input.part,
        species: input.species,
        dryYears: Number(input.dryYears) || 0,
        thicknessMm: Number(input.thicknessMm) || 0,
        grain: input.grain,
        defect: input.defect,
        receivedAt: input.receivedAt ?? new Date().toISOString(),
        remark: input.remark?.trim() || undefined,
      };
      await db.boards.put(toPlain(board));
      this.boards = [board, ...this.boards];
      return board;
    },

    async updateBoard(id: string, patch: Partial<BoardInput>) {
      const current = this.boards.find((b) => b.id === id);
      if (!current) return;
      const next: WoodBoard = { ...current, ...patch };
      await db.boards.put(toPlain(next));
      this.boards = this.boards.map((b) => (b.id === id ? next : b));
      // 重新登记（重测厚度、改阴干年限等）后，所在配对退出选材完成、标为待复核
      await this.flagPairReview(next.guqinNo, 'review');
    },

    /** 把某琴号的已配对板材标为待复核/待定；已是待复核或待定的保持原状 */
    async flagPairReview(guqinNo: string, review: PairReview) {
      if (!guqinNo || review === 'normal') return;
      const pair = this.pairs.find((p) => p.guqinNo === guqinNo);
      if (!pair?.matched || pair.review !== 'normal') return;
      const updated = this.boards.filter((b) => b.guqinNo === guqinNo).map((b) => ({ ...b, review }));
      for (const board of updated) {
        await db.boards.put(toPlain(board));
      }
      this.boards = this.boards.map((b) => updated.find((u) => u.id === b.id) ?? b);
    },

    /** 复核确认：配对恢复正常，重新计入选材完成 */
    async confirmPair(guqinNo: string) {
      const updated = this.boards
        .filter((b) => b.guqinNo === guqinNo && (b.review ?? 'normal') !== 'normal')
        .map((b) => ({ ...b, review: 'normal' as PairReview }));
      for (const board of updated) {
        await db.boards.put(toPlain(board));
      }
      this.boards = this.boards.map((b) => updated.find((u) => u.id === b.id) ?? b);
    },

    /**
     * 换料：料库新板替进配对中空出的部位，换下的旧板回到料库（可再配别的琴）。
     * 新板与留存板厚度差 > 2mm 或含水率差 > 1.5% 时，配对先存为待定。
     */
    async swapBoard(guqinNo: string, part: BoardPart, stockId: string): Promise<PairReview | null> {
      const pair = this.pairs.find((p) => p.guqinNo === guqinNo);
      const incoming = this.stockBoards.find((b) => b.id === stockId);
      if (!pair || !incoming) return null;
      const outgoing = part === '面板' ? pair.panel : pair.base;
      const remaining = part === '面板' ? pair.base : pair.panel;
      const review: PairReview = remaining && swapOutOfTolerance(incoming, remaining) ? 'pending' : 'normal';
      const updated: WoodBoard[] = [];
      if (outgoing) {
        updated.push({ ...outgoing, guqinNo: '', review: 'normal' });
      }
      updated.push({ ...incoming, guqinNo, part, review });
      if (remaining) {
        updated.push({ ...remaining, review });
      }
      for (const board of updated) {
        await db.boards.put(toPlain(board));
      }
      this.boards = this.boards.map((b) => updated.find((u) => u.id === b.id) ?? b);
      return review;
    },

    async removeBoard(id: string) {
      await db.boards.delete(id);
      this.boards = this.boards.filter((b) => b.id !== id);
    },

    /** 配对绑定：把某块板材与同琴号的另一部位板材绑定 */
    async pair(panelId: string, baseId: string) {
      const panel = this.boards.find((b) => b.id === panelId);
      const base = this.boards.find((b) => b.id === baseId);
      if (!panel || !base) return;
      const guqinNo = panel.guqinNo;
      const updated = [panel, base].map((b) => ({ ...b, guqinNo }));
      for (const board of updated) {
        await db.boards.put(toPlain(board));
      }
      this.boards = this.boards.map((b) => updated.find((u) => u.id === b.id) ?? b);
    },
  },
});
