import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { pairBoards, boardUsable, boardStatusOf, swapVerdict, type SwapVerdict } from '../utils/wood';
import type { BoardPart, BoardPair, WoodBoard, WoodDefect, WoodGrain, WoodSpecies } from '../types/wood-board';

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
    /** 料库板材（未配琴，换料时可替进空出的部位） */
    libraryBoards(state): WoodBoard[] {
      return state.boards.filter((b) => boardStatusOf(b) === '在库');
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
      const guqinNo = input.guqinNo.trim();
      const board: WoodBoard = {
        id: uid('board'),
        boardNo: input.boardNo.trim(),
        guqinNo,
        part: input.part,
        species: input.species,
        dryYears: Number(input.dryYears) || 0,
        thicknessMm: Number(input.thicknessMm) || 0,
        grain: input.grain,
        defect: input.defect,
        receivedAt: input.receivedAt ?? new Date().toISOString(),
        status: guqinNo ? '已配对' : '在库',
        remark: input.remark?.trim() || undefined,
      };
      await db.boards.put(toPlain(board));
      this.boards = [board, ...this.boards];
      return board;
    },

    async updateBoard(id: string, patch: Partial<BoardInput>) {
      const current = this.boards.find((b) => b.id === id);
      if (!current) return;
      const next: WoodBoard = { ...current, ...patch, guqinNo: (patch.guqinNo ?? current.guqinNo).trim() };

      const thicknessChanged = patch.thicknessMm !== undefined && Number(patch.thicknessMm) !== current.thicknessMm;
      const dryYearsChanged = patch.dryYears !== undefined && Number(patch.dryYears) !== current.dryYears;

      if (!next.guqinNo) {
        // 退回料库：不参与配对，也无需复核
        next.status = '在库';
        next.reviewNote = undefined;
      } else if (thicknessChanged || dryYearsChanged) {
        // 重测厚度或改阴干年限：所在配对退出选材完成，标待复核，确认后才恢复
        const changes: string[] = [];
        if (thicknessChanged) changes.push(`厚度 ${current.thicknessMm}→${next.thicknessMm}mm`);
        if (dryYearsChanged) changes.push(`阴干 ${current.dryYears}→${next.dryYears}年`);
        next.status = '待复核';
        next.reviewNote = `重新登记：${changes.join('，')}`;
      } else if (boardStatusOf(current) === '在库') {
        next.status = '已配对';
      }

      await db.boards.put(toPlain(next));
      this.boards = this.boards.map((b) => (b.id === id ? next : b));
    },

    async removeBoard(id: string) {
      await db.boards.delete(id);
      this.boards = this.boards.filter((b) => b.id !== id);
    },

    /** 确认复核：配对内待复核 / 待定的板材恢复已配对，选材重新记为完成 */
    async confirmPair(guqinNo: string) {
      const restored = this.boards
        .filter((b) => b.guqinNo === guqinNo && (b.status === '待复核' || b.status === '待定'))
        .map((b) => ({ ...b, status: '已配对' as const, reviewNote: undefined }));
      for (const board of restored) {
        await db.boards.put(toPlain(board));
      }
      this.boards = this.boards.map((b) => restored.find((r) => r.id === b.id) ?? b);
    },

    /**
     * 换料：新板替进旧板空出的那一边（同琴号同部位），旧板退回料库可再配别的琴。
     * 新旧板厚度差 > 2mm 或含水率差 > 1.5% 时新板先存待定，确认后才恢复选材完成。
     */
    async swapBoard(oldId: string, newId: string): Promise<SwapVerdict | undefined> {
      const oldBoard = this.boards.find((b) => b.id === oldId);
      const incoming = this.boards.find((b) => b.id === newId);
      if (!oldBoard || !incoming || !oldBoard.guqinNo) return undefined;

      const verdict = swapVerdict(oldBoard, incoming);
      const released: WoodBoard = {
        ...oldBoard,
        guqinNo: '',
        status: '在库',
        reviewNote: undefined,
      };
      const placed: WoodBoard = {
        ...incoming,
        guqinNo: oldBoard.guqinNo,
        part: oldBoard.part,
        status: verdict.pending ? '待定' : '已配对',
        reviewNote: verdict.pending ? `换料超差：${verdict.reasons.join('，')}` : undefined,
      };
      for (const board of [released, placed]) {
        await db.boards.put(toPlain(board));
      }
      this.boards = this.boards.map((b) => {
        if (b.id === released.id) return released;
        if (b.id === placed.id) return placed;
        return b;
      });
      return verdict;
    },

    /** 配对绑定：把某块板材与同琴号的另一部位板材绑定 */
    async pair(panelId: string, baseId: string) {
      const panel = this.boards.find((b) => b.id === panelId);
      const base = this.boards.find((b) => b.id === baseId);
      if (!panel || !base) return;
      const guqinNo = panel.guqinNo;
      const updated = [panel, base].map((b) => ({ ...b, guqinNo, status: '已配对' as const }));
      for (const board of updated) {
        await db.boards.put(toPlain(board));
      }
      this.boards = this.boards.map((b) => updated.find((u) => u.id === b.id) ?? b);
    },
  },
});
