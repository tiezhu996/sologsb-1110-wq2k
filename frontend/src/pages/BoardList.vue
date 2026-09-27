<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type TagProps } from 'element-plus';
import FilterBar from '../components/common/FilterBar.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import DimensionChart from '../components/common/DimensionChart.vue';
import { useBoardStore } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useGuqinFilter } from '../hooks/useGuqinFilter';
import {
  boardPending,
  boardStatusOf,
  moisturePctOf,
  swapVerdict,
  thicknessGap,
  SWAP_MOISTURE_TOLERANCE_PCT,
  SWAP_THICKNESS_TOLERANCE_MM,
} from '../utils/wood';
import { formatDate } from '../utils/layer';
import {
  BOARD_PARTS,
  WOOD_DEFECTS,
  WOOD_GRAINS,
  WOOD_SPECIES,
  type BoardPair,
  type BoardPart,
  type BoardStatus,
  type WoodBoard,
  type WoodDefect,
  type WoodGrain,
  type WoodSpecies,
} from '../types/wood-board';

const boardStore = useBoardStore();
const chamberStore = useChamberStore();
const filter = useGuqinFilter();

const dialogVisible = ref(false);
const editingId = ref('');
const formRef = ref<FormInstance>();
const selectedGuqin = ref('');

interface BoardForm {
  boardNo: string;
  guqinNo: string;
  part: BoardPart;
  species: WoodSpecies;
  dryYears: number;
  thicknessMm: number;
  grain: WoodGrain;
  defect: WoodDefect;
  receivedAt: string;
  remark: string;
}

const form = ref<BoardForm>({
  boardNo: '',
  guqinNo: '',
  part: '面板',
  species: '桐木',
  dryYears: 5,
  thicknessMm: 30,
  grain: '直纹',
  defect: '无',
  receivedAt: new Date().toISOString().slice(0, 10),
  remark: '',
});

const rules: FormRules = {
  boardNo: [{ required: true, message: '请输入板材号', trigger: 'blur' }],
};

const visible = computed(() => filter.applyBoards(boardStore.boards));
const visiblePairs = computed(() => {
  const nos = new Set(visible.value.map((b) => b.guqinNo).filter(Boolean));
  return boardStore.pairs.filter((pair) => nos.has(pair.guqinNo));
});

const chartMarks = computed(() => (selectedGuqin.value ? chamberStore.marksOf(selectedGuqin.value) : []));
const chartDepth = computed(() => chamberStore.byGuqin(selectedGuqin.value)?.chamberDepth ?? 0);

const STATUS_TAG_TYPE: Record<BoardStatus, TagProps['type']> = {
  在库: 'info',
  已配对: 'success',
  待复核: 'warning',
  待定: 'danger',
};

/** 配对状态标签：待复核 / 待定优先于已配对展示 */
function pairTag(pair: BoardPair): { type: TagProps['type']; label: string } {
  if (pair.needsReview) {
    const statuses = [pair.panel, pair.base].filter((b): b is WoodBoard => Boolean(b)).map(boardStatusOf);
    return statuses.includes('待定')
      ? { type: 'danger', label: '待定' }
      : { type: 'warning', label: '待复核' };
  }
  return pair.matched ? { type: 'success', label: '已配对' } : { type: 'warning', label: '待配对' };
}

function openCreate() {
  editingId.value = '';
  form.value = {
    boardNo: `MB-${Date.now().toString().slice(-4)}`,
    guqinNo: boardStore.guqinNos[0] ?? 'Q-2506',
    part: '面板',
    species: '桐木',
    dryYears: 5,
    thicknessMm: 30,
    grain: '直纹',
    defect: '无',
    receivedAt: new Date().toISOString().slice(0, 10),
    remark: '',
  };
  dialogVisible.value = true;
}

function openEdit(board: WoodBoard) {
  editingId.value = board.id;
  form.value = {
    boardNo: board.boardNo,
    guqinNo: board.guqinNo,
    part: board.part,
    species: board.species,
    dryYears: board.dryYears,
    thicknessMm: board.thicknessMm,
    grain: board.grain,
    defect: board.defect,
    receivedAt: board.receivedAt.slice(0, 10),
    remark: board.remark ?? '',
  };
  dialogVisible.value = true;
}

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  const payload = {
    boardNo: form.value.boardNo,
    guqinNo: form.value.guqinNo,
    part: form.value.part,
    species: form.value.species,
    dryYears: Number(form.value.dryYears) || 0,
    thicknessMm: Number(form.value.thicknessMm) || 0,
    grain: form.value.grain,
    defect: form.value.defect,
    receivedAt: new Date(`${form.value.receivedAt}T09:00:00`).toISOString(),
    remark: form.value.remark,
  };
  if (editingId.value) {
    const before = boardStore.boards.find((b) => b.id === editingId.value);
    await boardStore.updateBoard(editingId.value, payload);
    const dimensionChanged =
      before && (before.thicknessMm !== payload.thicknessMm || before.dryYears !== payload.dryYears);
    if (dimensionChanged && payload.guqinNo.trim()) {
      ElMessage.warning(`已更新板材 ${payload.boardNo}；尺寸变更，所在配对退出选材完成，待复核确认后恢复`);
    } else {
      ElMessage.success(`已更新板材 ${payload.boardNo}`);
    }
  } else {
    await boardStore.addBoard(payload);
    ElMessage.success(
      payload.guqinNo.trim()
        ? `已登记板材 ${payload.boardNo}（${payload.part}）`
        : `已登记板材 ${payload.boardNo}（${payload.part}），入料库`,
    );
  }
  dialogVisible.value = false;
}

async function remove(board: WoodBoard) {
  const confirmed = await ElMessageBox.confirm(`确认删除板材 ${board.boardNo}？`, '删除确认', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await boardStore.removeBoard(board.id);
  ElMessage.success('已删除');
}

/** 确认复核：配对恢复已配对，进度页选材重新记为完成 */
async function confirmPair(pair: BoardPair) {
  const confirmed = await ElMessageBox.confirm(
    `${pair.guqinNo}：${pair.pendingNote}。确认复核无误，恢复选材完成？`,
    '复核确认',
    { type: 'warning', confirmButtonText: '确认恢复', cancelButtonText: '再等等' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await boardStore.confirmPair(pair.guqinNo);
  ElMessage.success(`${pair.guqinNo} 已恢复选材完成`);
}

// ---- 换料：新板替进空出的那一边，旧板退回料库 ----
const swapVisible = ref(false);
const swapGuqinNo = ref('');
const swapPart = ref<BoardPart>('面板');
const swapOldId = ref('');
const swapNewId = ref('');

const swapOld = computed(() => boardStore.boards.find((b) => b.id === swapOldId.value));
/** 料库中同部位的可替入板材 */
const swapCandidates = computed(() => boardStore.libraryBoards.filter((b) => b.part === swapPart.value));
const swapNew = computed(() => boardStore.libraryBoards.find((b) => b.id === swapNewId.value));
/** 实时校验：厚度差 > 2mm 或含水率差 > 1.5% 先存待定 */
const swapCheck = computed(() => (swapOld.value && swapNew.value ? swapVerdict(swapOld.value, swapNew.value) : undefined));

function openSwap(pair: BoardPair, part: BoardPart) {
  swapGuqinNo.value = pair.guqinNo;
  swapPart.value = part;
  swapOldId.value = (part === '面板' ? pair.panel?.id : pair.base?.id) ?? '';
  swapNewId.value = '';
  swapVisible.value = true;
}

async function submitSwap() {
  if (!swapOldId.value || !swapNewId.value || !swapNew.value) return;
  const newBoardNo = swapNew.value.boardNo;
  const verdict = await boardStore.swapBoard(swapOldId.value, swapNewId.value);
  swapVisible.value = false;
  if (verdict?.pending) {
    ElMessage.warning(`已换入 ${newBoardNo}，但${verdict.reasons.join('，')}，先存待定；旧板已退回料库`);
  } else {
    ElMessage.success(`已换入 ${newBoardNo}，旧板退回料库可再配别的琴`);
  }
}
</script>

<template>
  <div>
    <h2 class="page-title">板材登记与配对</h2>
    <p class="page-desc">
      同一琴号下面板与底板配对绑定，并按阴干年限回显含水率；重测厚度或改阴干年限的配对退出选材完成、标待复核，确认后恢复；
      换料时新板替进空出的部位，超差先存待定，旧板退回料库可再配。
    </p>

    <div class="toolbar">
      <el-button type="primary" @click="openCreate">登记板材</el-button>
      <el-button @click="selectedGuqin = boardStore.guqinNos[0] ?? ''">查看首张琴剖面</el-button>
    </div>

    <FilterBar
      :fields="[
        { key: 'guqin', label: '琴号', options: boardStore.guqinNos, width: 130 },
        { key: 'species', label: '树种', options: WOOD_SPECIES, width: 110 },
      ]"
      :result-count="visible.length"
      :total-count="boardStore.boards.length"
    />

    <EmptyPanel
      v-if="visible.length === 0"
      description="没有符合条件的板材"
      action-text="重置筛选条件"
      @action="filter.reset()"
    />

    <template v-else>
      <el-card shadow="never" class="block">
        <template #header>面板 / 底板配对（含水率回显）</template>
        <el-table :data="visiblePairs" size="small" border>
          <el-table-column prop="guqinNo" label="琴号" width="100" />
          <el-table-column label="面板" min-width="240">
            <template #default="scope">
              <template v-if="scope.row.panel">
                <span>{{ scope.row.panel.boardNo }} · {{ scope.row.panel.species }} · {{ scope.row.panel.thicknessMm }}mm</span>
                <el-tag
                  v-if="boardPending(scope.row.panel)"
                  :type="STATUS_TAG_TYPE[boardStatusOf(scope.row.panel)]"
                  size="small"
                  class="cell-tag"
                >
                  {{ boardStatusOf(scope.row.panel) }}
                </el-tag>
                <el-button link type="primary" size="small" @click="openSwap(scope.row, '面板')">换料</el-button>
              </template>
              <el-tag v-else type="danger" size="small">缺面板</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="底板" min-width="240">
            <template #default="scope">
              <template v-if="scope.row.base">
                <span>{{ scope.row.base.boardNo }} · {{ scope.row.base.species }} · {{ scope.row.base.thicknessMm }}mm</span>
                <el-tag
                  v-if="boardPending(scope.row.base)"
                  :type="STATUS_TAG_TYPE[boardStatusOf(scope.row.base)]"
                  size="small"
                  class="cell-tag"
                >
                  {{ boardStatusOf(scope.row.base) }}
                </el-tag>
                <el-button link type="primary" size="small" @click="openSwap(scope.row, '底板')">换料</el-button>
              </template>
              <el-tag v-else type="danger" size="small">缺底板</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="含水率" width="90">
            <template #default="scope">{{ scope.row.moisturePct }}%</template>
          </el-table-column>
          <el-table-column label="板厚差(mm)" width="100">
            <template #default="scope">{{ thicknessGap(scope.row) }}</template>
          </el-table-column>
          <el-table-column label="配对状态" min-width="160">
            <template #default="scope">
              <el-tag :type="pairTag(scope.row).type" size="small">{{ pairTag(scope.row).label }}</el-tag>
              <div v-if="scope.row.pendingNote" class="pending-note">{{ scope.row.pendingNote }}</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="180" fixed="right">
            <template #default="scope">
              <el-button v-if="scope.row.needsReview" link type="warning" @click="confirmPair(scope.row)">确认复核</el-button>
              <el-button link type="primary" @click="selectedGuqin = scope.row.guqinNo">剖面标注</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>板材明细（琴号为空即在料库）</template>
        <el-table :data="visible" size="small" border>
          <el-table-column prop="boardNo" label="板材号" width="110" />
          <el-table-column label="琴号" width="90">
            <template #default="scope">{{ scope.row.guqinNo || '料库' }}</template>
          </el-table-column>
          <el-table-column prop="part" label="部位" width="70" />
          <el-table-column label="状态" width="90">
            <template #default="scope">
              <el-tag
                :type="STATUS_TAG_TYPE[boardStatusOf(scope.row)]"
                size="small"
                effect="plain"
                :title="scope.row.reviewNote"
              >
                {{ boardStatusOf(scope.row) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="species" label="树种" width="80" />
          <el-table-column prop="dryYears" label="阴干(年)" width="90" />
          <el-table-column prop="thicknessMm" label="厚度(mm)" width="90" />
          <el-table-column label="含水率" width="90">
            <template #default="scope">{{ moisturePctOf(scope.row.dryYears) }}%</template>
          </el-table-column>
          <el-table-column prop="grain" label="木纹" width="90" />
          <el-table-column prop="defect" label="缺陷" width="80" />
          <el-table-column label="入库" width="110">
            <template #default="scope">{{ formatDate(scope.row.receivedAt) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="110" />
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
              <el-button link type="danger" @click="remove(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>槽腹剖面标注（DimensionChart）</span>
            <el-select v-model="selectedGuqin" placeholder="选择琴号" clearable style="width: 160px">
              <el-option v-for="no in boardStore.guqinNos" :key="no" :label="no" :value="no" />
            </el-select>
          </div>
        </template>
        <DimensionChart v-if="chartMarks.length" :marks="chartMarks" :chamber-depth="chartDepth" :guqin-no="selectedGuqin" />
        <el-empty v-else :image-size="60" description="选择已有槽腹记录的琴号即可查看剖面标注" />
      </el-card>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑板材' : '登记板材'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="板材号" prop="boardNo">
          <el-input v-model="form.boardNo" placeholder="如：MB-2511" maxlength="20" />
        </el-form-item>
        <el-form-item label="琴号">
          <el-input v-model="form.guqinNo" placeholder="如：Q-2506；留空则入料库" maxlength="20" />
        </el-form-item>
        <el-form-item label="部位">
          <el-select v-model="form.part" style="width: 160px">
            <el-option v-for="part in BOARD_PARTS" :key="part" :label="part" :value="part" />
          </el-select>
        </el-form-item>
        <el-form-item label="树种">
          <el-select v-model="form.species" style="width: 160px">
            <el-option v-for="species in WOOD_SPECIES" :key="species" :label="species" :value="species" />
          </el-select>
        </el-form-item>
        <el-form-item label="阴干年限(年)">
          <el-input-number v-model="form.dryYears" :min="0" :max="60" placeholder="阴干年限" />
        </el-form-item>
        <el-form-item label="厚度(mm)">
          <el-input-number v-model="form.thicknessMm" :min="5" :max="80" :step="0.5" placeholder="厚度" />
        </el-form-item>
        <el-form-item label="木纹">
          <el-select v-model="form.grain" style="width: 160px">
            <el-option v-for="grain in WOOD_GRAINS" :key="grain" :label="grain" :value="grain" />
          </el-select>
        </el-form-item>
        <el-form-item label="缺陷">
          <el-select v-model="form.defect" style="width: 160px">
            <el-option v-for="defect in WOOD_DEFECTS" :key="defect" :label="defect" :value="defect" />
          </el-select>
        </el-form-item>
        <el-form-item label="入库日期">
          <el-date-picker v-model="form.receivedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="60" placeholder="产地、纹理等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="swapVisible" :title="`换料 · ${swapGuqinNo} ${swapPart}`" width="600px">
      <el-alert
        v-if="swapOld"
        type="info"
        :closable="false"
        show-icon
        :title="`换下：${swapOld.boardNo} · ${swapOld.species} · ${swapOld.thicknessMm}mm · 阴干 ${swapOld.dryYears} 年 · 含水率 ${moisturePctOf(swapOld.dryYears)}%（换料后退回料库）`"
        class="swap-alert"
      />
      <el-form label-width="120px">
        <el-form-item label="新板（料库）">
          <el-select v-model="swapNewId" placeholder="选择同部位在库板材" style="width: 100%" no-data-text="料库中没有同部位板材">
            <el-option
              v-for="b in swapCandidates"
              :key="b.id"
              :value="b.id"
              :label="`${b.boardNo} · ${b.species} · ${b.thicknessMm}mm · 阴干 ${b.dryYears} 年 · 含水率 ${moisturePctOf(b.dryYears)}%`"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="swapCheck" label="差异校验">
          <div class="swap-check">
            <span>
              厚度差 {{ swapCheck.thicknessDiff }}mm（限 {{ SWAP_THICKNESS_TOLERANCE_MM }}mm） · 含水率差
              {{ swapCheck.moistureDiff }}%（限 {{ SWAP_MOISTURE_TOLERANCE_PCT }}%）
            </span>
            <el-tag :type="swapCheck.pending ? 'danger' : 'success'" size="small">
              {{ swapCheck.pending ? '超差，先存待定' : '容差内，直接替入' }}
            </el-tag>
          </div>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="swapCheck?.pending"
        type="warning"
        :closable="false"
        show-icon
        :title="`${swapCheck.reasons.join('；')}。新板先存待定，确认复核后才恢复选材完成。`"
      />
      <template #footer>
        <el-button @click="swapVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!swapNewId" @click="submitSwap">确认换料</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #4a3728;
}
.page-desc {
  margin: 0 0 12px;
  color: #8a7a68;
  font-size: 13px;
}
.toolbar {
  margin-bottom: 12px;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.cell-tag {
  margin: 0 4px;
}
.pending-note {
  margin-top: 4px;
  font-size: 12px;
  color: #b88230;
  line-height: 1.4;
}
.swap-alert {
  margin-bottom: 12px;
}
.swap-check {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
