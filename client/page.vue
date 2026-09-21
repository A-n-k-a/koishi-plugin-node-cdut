<template>
  <k-layout>
    <div class="node-cdut-page">
      <el-card class="node-cdut-card" shadow="never">
        <template #header>
          <div class="card-header">连接测试</div>
        </template>
        <p class="hint">
          Base URL、统一身份认证账号密码与默认房间请在插件设置中配置; 此处用于验证连通性。
        </p>
        <el-button type="primary" :loading="loginLoading" @click="testLogin">测试登录</el-button>
        <el-alert
          v-if="loginResult"
          class="result"
          :type="loginResult.success ? 'success' : 'error'"
          :title="loginResult.message"
          :closable="false"
          show-icon
        />
      </el-card>

      <el-card class="node-cdut-card" shadow="never">
        <template #header>
          <div class="card-header">房间查询测试</div>
        </template>
        <p class="hint">以下字段留空时使用插件设置中的默认房间信息。</p>
        <el-form label-width="5em" @submit.prevent>
          <el-form-item label="园区">
            <el-select v-model="park" clearable placeholder="默认" class="field">
              <el-option v-for="p in parks" :key="p" :label="p" :value="p" />
            </el-select>
          </el-form-item>
          <el-form-item label="用电类型">
            <el-select v-model="type" clearable placeholder="默认" class="field">
              <el-option label="照明" value="照明" />
              <el-option label="空调" value="空调" />
              <el-option label="照明和空调" value="both" />
            </el-select>
          </el-form-item>
          <el-form-item label="栋号">
            <el-input v-model="building" placeholder="默认, 如 1" class="field" />
          </el-form-item>
          <el-form-item label="房间号">
            <el-input v-model="roomNo" placeholder="默认, 如 512" class="field" />
          </el-form-item>
        </el-form>
        <el-button type="primary" :loading="balanceLoading" @click="testBalance">测试房间查询</el-button>
        <el-alert
          v-if="balanceResult"
          class="result"
          :type="balanceResult.success ? 'success' : 'error'"
          :title="balanceResult.message"
          :closable="false"
          show-icon
        />
      </el-card>

      <el-card class="node-cdut-card" shadow="never">
        <template #header>
          <div class="card-header cron-header">
            <span>定时任务</span>
            <el-button text type="primary" :loading="cronLoading" @click="loadCronTimes">刷新</el-button>
          </div>
        </template>
        <p class="hint">
          定时任务在插件设置中配置; 此处展示每个任务的指令、目标与未来触发时间 (显示条数由设置中的「未来触发次数」指定)。
        </p>
        <el-empty v-if="!cronLoading && !cronJobs.length" description="未配置定时任务" />
        <div v-for="(job, index) in cronJobs" :key="index" class="cron-job">
          <div class="cron-job-title">
            <el-tag size="small" :type="job.enabled ? 'success' : 'info'">{{ job.enabled ? '已启用' : '未启用' }}</el-tag>
            <el-tag size="small" type="warning">{{ job.command }}</el-tag>
            <code>{{ job.expression || '(未设置表达式)' }}</code>
          </div>
          <div v-if="job.arguments" class="cron-detail">参数: {{ job.arguments }}</div>
          <div class="cron-detail">目标: {{ job.targets.length ? job.targets.join(', ') : '(未设置目标)' }}</div>
          <el-alert
            v-if="job.error"
            class="result"
            type="error"
            :title="job.error"
            :closable="false"
            show-icon
          />
          <ul v-else class="cron-times">
            <li v-for="(time, i) in job.times" :key="i">{{ formatTime(time) }}</li>
          </ul>
        </div>
      </el-card>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { ref } from 'vue'
import { send } from '@koishijs/client'

interface TestResult {
  success: boolean
  message: string
}

const parks = ['榕树园', '珙桐园', '松林园', '银杏园', '芙蓉园', '香樟园']

const park = ref('')
const type = ref('')
const building = ref('')
const roomNo = ref('')

const loginLoading = ref(false)
const loginResult = ref<TestResult>()

async function testLogin() {
  loginLoading.value = true
  loginResult.value = undefined
  try {
    loginResult.value = await send('node-cdut/test-login')
  } catch (err) {
    loginResult.value = { success: false, message: String(err) }
  } finally {
    loginLoading.value = false
  }
}

const balanceLoading = ref(false)
const balanceResult = ref<TestResult>()

interface CronJobPreview {
  command: string
  arguments: string
  expression: string
  targets: string[]
  enabled: boolean
  times: string[]
  error?: string
}

const cronLoading = ref(false)
const cronJobs = ref<CronJobPreview[]>([])

async function loadCronTimes() {
  cronLoading.value = true
  try {
    cronJobs.value = await send('node-cdut/cron-times')
  } finally {
    cronLoading.value = false
  }
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

loadCronTimes()

async function testBalance() {
  balanceLoading.value = true
  balanceResult.value = undefined
  try {
    balanceResult.value = await send('node-cdut/test-balance', {
      park: park.value || undefined,
      type: type.value || undefined,
      building: building.value || undefined,
      roomNo: roomNo.value || undefined,
    })
  } catch (err) {
    balanceResult.value = { success: false, message: String(err) }
  } finally {
    balanceLoading.value = false
  }
}
</script>

<style scoped>
/* console 的 .layout-main 为 overflow: hidden, 页面需自行提供滚动容器 */
.node-cdut-page {
  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
}

.node-cdut-card {
  margin: 1rem;
}

.hint {
  margin-top: 0;
  color: var(--el-text-color-secondary);
  font-size: 0.9em;
}

.field {
  width: 16rem;
}

.result {
  margin-top: 1rem;
  white-space: pre-wrap;
}

.cron-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cron-job + .cron-job {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--el-border-color-lighter);
}

.cron-job-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.cron-detail {
  margin-top: 0.25rem;
  color: var(--el-text-color-secondary);
  font-size: 0.9em;
}

.cron-target {
  color: var(--el-text-color-secondary);
}

.cron-times {
  margin: 0.5rem 0 0;
  padding-left: 1.5rem;
}
</style>
