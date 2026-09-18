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
</style>
