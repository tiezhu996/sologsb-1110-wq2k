<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import FilterBar from '../components/common/FilterBar.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import DimensionChart from '../components/common/DimensionChart.vue';
import { useBoardStore } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useGuqinFilter } from '../hooks/useGuqinFilter';
import {
  moisturePctOf,
  swapOutOfTolerance,
  thicknessGap,
  SWAP_MOISTURE_TOLERANCE_PCT,
  SWAP_THICKNESS_TOLERANCE_MM,
} from '../utils/wood';
import { formatDate } from '../utils/layer';
import {
  BOARD_PARTS,
  PAIR_REVIEW_LABELS,
  WOOD_DEFECTS,
  WOOD_GRAINS,
  WOOD_SPECIES,
  type BoardPair,
  type BoardPart,
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
  const nos = new Set(visible.value.map((b) => b.guqinNo));
  return boardStore.pairs.filter((pair) => nos.has(pair.guqinNo));
});

const chartMarks = computed(() => (selectedGuqin.value ? chamberStore.marksOf(selectedGuqin.value) : []));
const chartDepth = computed(() => chamberStore.byGuqin(selectedGuqin.value)?.chamberDepth ?? 0);

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
    await boardStore.updateBoard(editingId.value, payload);
    const pair = boardStore.pairs.find((p) => p.guqinNo === payload.guqinNo);
    if (pair?.matched && pair.review === 'review') {
      ElMessage.warning(`已更新板材 ${payload.boardNo}，所在配对已退出选材完成、标为待复核`);
    } else {
      ElMessage.success(`已更新板材 ${payload.boardNo}`);
    }
  } else {
    await boardStore.addBoard(payload);
    ElMessage.success(`已登记板材 ${payload.boardNo}（${payload.part}）`);
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

/** 复核确认：配对恢复正常、重新计入选材完成 */
async function confirmPair(pair: BoardPair) {
  await boardStore.confirmPair(pair.guqinNo);
  ElMessage.success(`${pair.guqinNo} 配对已确认，恢复选材完成`);
}

function reviewLabel(board: WoodBoard): string {
  return PAIR_REVIEW_LABELS[board.review ?? 'normal'];
}

/* ---------- 换料 ---------- */

const swapVisible = ref(false);
const swapGuqin = ref('');
const swapPart = ref<BoardPart>('面板');
const swapStockId = ref('');

/** 当前换料操作的配对与留存的另一侧板材 */
const swapPair = computed(() => boardStore.pairs.find((p) => p.guqinNo === swapGuqin.value));
const swapRemaining = computed(() => (swapPart.value === '面板' ? swapPair.value?.base : swapPair.value?.panel));
/** 料库中与新板同部位的候选板材 */
const swapCandidates = computed(() => boardStore.stockBoards.filter((b) => b.part === swapPart.value));
const swapIncoming = computed(() => swapCandidates.value.find((b) => b.id === swapStockId.value));

/** 选中候选后与留存板的差距预览 */
const swapPreview = computed(() => {
  const incoming = swapIncoming.value;
  const remaining = swapRemaining.value;
  if (!incoming || !remaining) return null;
  const thicknessDiff = Number(Math.abs(incoming.thicknessMm - remaining.thicknessMm).toFixed(1));
  const moistureDiff = Number(
    Math.abs(moisturePctOf(incoming.dryYears) - moisturePctOf(remaining.dryYears)).toFixed(1),
  );
  return {
    thicknessDiff,
    moistureDiff,
    outOfTolerance: swapOutOfTolerance(incoming, remaining),
  };
});

function openSwap(pair: BoardPair) {
  swapGuqin.value = pair.guqinNo;
  swapPart.value = pair.panel && !pair.base ? '底板' : '面板';
  swapStockId.value = '';
  swapVisible.value = true;
}

async function submitSwap() {
  if (!swapStockId.value) {
    ElMessage.warning('请选择料库中的替换板材');
    return;
  }
  const result = await boardStore.swapBoard(swapGuqin.value, swapPart.value, swapStockId.value);
  if (!result) return;
  swapVisible.value = false;
  if (result === 'pending') {
    ElMessage.warning(
      `已换料，但厚度差超过 ${SWAP_THICKNESS_TOLERANCE_MM}mm 或含水率差超过 ${SWAP_MOISTURE_TOLERANCE_PCT}%，配对先存为待定`,
    );
  } else {
    ElMessage.success('已换料，旧板已回到料库');
  }
}
</script>

<template>
  <div>
    <h2 class="page-title">板材登记与配对</h2>
    <p class="page-desc">
      同一琴号下面板与底板配对绑定，并按阴干年限回显含水率；重新登记的板材所在配对退出选材完成、标为待复核，确认后恢复；换料从料库取板，超差先存待定，旧板回库可再配。
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
          <el-table-column prop="guqinNo" label="琴号" width="110" />
          <el-table-column label="面板" min-width="200">
            <template #default="scope">
              <span v-if="scope.row.panel">{{ scope.row.panel.boardNo }} · {{ scope.row.panel.species }} · {{ scope.row.panel.thicknessMm }}mm</span>
              <el-tag v-else type="danger" size="small">缺面板</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="底板" min-width="200">
            <template #default="scope">
              <span v-if="scope.row.base">{{ scope.row.base.boardNo }} · {{ scope.row.base.species }} · {{ scope.row.base.thicknessMm }}mm</span>
              <el-tag v-else type="danger" size="small">缺底板</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="含水率" width="110">
            <template #default="scope">{{ scope.row.moisturePct }}%</template>
          </el-table-column>
          <el-table-column label="板厚差(mm)" width="120">
            <template #default="scope">{{ thicknessGap(scope.row) }}</template>
          </el-table-column>
          <el-table-column label="配对状态" width="110">
            <template #default="scope">
              <el-tag v-if="!scope.row.matched" type="warning" size="small">待配对</el-tag>
              <el-tag v-else-if="scope.row.review === 'review'" type="danger" size="small">待复核</el-tag>
              <el-tag v-else-if="scope.row.review === 'pending'" type="danger" size="small">待定</el-tag>
              <el-tag v-else type="success" size="small">已配对</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="220">
            <template #default="scope">
              <el-button link type="primary" @click="selectedGuqin = scope.row.guqinNo">剖面标注</el-button>
              <el-button link type="primary" @click="openSwap(scope.row)">换料</el-button>
              <el-button v-if="scope.row.review !== 'normal'" link type="success" @click="confirmPair(scope.row)">
                确认复核
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>板材明细</template>
        <el-table :data="visible" size="small" border>
          <el-table-column prop="boardNo" label="板材号" width="120" />
          <el-table-column label="琴号" width="100">
            <template #default="scope">
              <span v-if="scope.row.guqinNo">{{ scope.row.guqinNo }}</span>
              <el-tag v-else type="info" size="small">在库</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="part" label="部位" width="80" />
          <el-table-column prop="species" label="树种" width="80" />
          <el-table-column prop="dryYears" label="阴干(年)" width="90" />
          <el-table-column prop="thicknessMm" label="厚度(mm)" width="90" />
          <el-table-column prop="grain" label="木纹" width="90" />
          <el-table-column prop="defect" label="缺陷" width="80" />
          <el-table-column label="入库" width="110">
            <template #default="scope">{{ formatDate(scope.row.receivedAt) }}</template>
          </el-table-column>
          <el-table-column label="复核" width="90">
            <template #default="scope">
              <el-tag v-if="(scope.row.review ?? 'normal') !== 'normal'" type="danger" size="small">
                {{ reviewLabel(scope.row) }}
              </el-tag>
              <span v-else>—</span>
            </template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="120" />
          <el-table-column label="操作" width="150" fixed="right">
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
        <el-form-item label="琴号" prop="guqinNo">
          <el-input v-model="form.guqinNo" placeholder="如：Q-2506（留空为在库板材）" maxlength="20" />
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

    <el-dialog v-model="swapVisible" :title="`换料 · ${swapGuqin}`" width="560px">
      <el-form label-width="110px">
        <el-form-item label="替换部位">
          <el-radio-group v-model="swapPart" @change="swapStockId = ''">
            <el-radio-button v-for="part in BOARD_PARTS" :key="part" :value="part">{{ part }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="留存板材">
          <span v-if="swapRemaining">
            {{ swapRemaining.boardNo }} · {{ swapRemaining.species }} · {{ swapRemaining.thicknessMm }}mm · 含水率
            {{ moisturePctOf(swapRemaining.dryYears) }}%
          </span>
          <el-tag v-else type="warning" size="small">该琴号暂无另一侧板材</el-tag>
        </el-form-item>
        <el-form-item label="料库新板">
          <el-select v-model="swapStockId" placeholder="选择在库板材" style="width: 100%">
            <el-option
              v-for="board in swapCandidates"
              :key="board.id"
              :label="`${board.boardNo} · ${board.species} · ${board.thicknessMm}mm · 含水率 ${moisturePctOf(board.dryYears)}%`"
              :value="board.id"
            />
          </el-select>
          <div v-if="!swapCandidates.length" class="swap-hint">料库中暂无{{ swapPart }}，可先在登记表单留空琴号入库。</div>
        </el-form-item>
        <el-form-item v-if="swapPreview" label="差距预览">
          <el-alert
            :type="swapPreview.outOfTolerance ? 'warning' : 'success'"
            :closable="false"
            :title="
              swapPreview.outOfTolerance
                ? `厚度差 ${swapPreview.thicknessDiff}mm / 含水率差 ${swapPreview.moistureDiff}%，超差将存为待定`
                : `厚度差 ${swapPreview.thicknessDiff}mm / 含水率差 ${swapPreview.moistureDiff}%，在容差内`
            "
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="swapVisible = false">取消</el-button>
        <el-button type="primary" @click="submitSwap">确认换料</el-button>
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
.swap-hint {
  margin-top: 4px;
  color: #8a7a68;
  font-size: 12px;
}
</style>
