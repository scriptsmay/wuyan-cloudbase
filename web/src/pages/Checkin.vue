<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const loading = ref(false)
const checkedIn = ref(false)
const todayCount = ref(0)
const myStreak = ref(0)
const myTotal = ref(0)
const error = ref<string | null>(null)

async function fetchStatus() {
  try {
    // TODO: 替换为真实 API 调用 GET /api/checkins/me
    // 目前显示占位数据
  } catch {
    // 静默
  }
}

async function doCheckin() {
  loading.value = true
  error.value = null
  try {
    // TODO: 替换为真实 API 调用 POST /api/checkins
    await new Promise(r => setTimeout(r, 600))
    checkedIn.value = true
    myStreak.value += 1
    myTotal.value += 1
    todayCount.value += 1
  } catch {
    error.value = '打卡失败，请重试'
  } finally {
    loading.value = false
  }
}

onMounted(fetchStatus)
</script>

<template>
  <div class="checkin-page">
    <button class="back-btn" @click="router.push('/')">← 返回</button>
    <h2>每日加油打卡</h2>

    <div class="stats-row">
      <div class="stat-item">
        <span class="stat-value">{{ todayCount }}</span>
        <span class="stat-label">今日打卡</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ myStreak }}</span>
        <span class="stat-label">连续天数</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ myTotal }}</span>
        <span class="stat-label">累计打卡</span>
      </div>
    </div>

    <button
      class="checkin-btn"
      :class="{ done: checkedIn }"
      :disabled="checkedIn || loading"
      @click="doCheckin"
    >
      {{ checkedIn ? '✅ 今日已打卡' : loading ? '打卡中...' : '🔥 一键打卡' }}
    </button>

    <p v-if="checkedIn && !loading" class="checkin-tip">
      加油卡已生成，前往 <router-link to="/cheer">AI 应援</router-link> 查看
    </p>
    <p v-if="error" class="error-msg">{{ error }}</p>
  </div>
</template>

<style scoped>
.checkin-page {
  max-width: 480px;
  margin: 0 auto;
  padding: 2rem 1rem;
  min-height: 100dvh;
}

.back-btn {
  background: none;
  border: none;
  color: var(--primary, #00d4ff);
  cursor: pointer;
  font-size: 0.95rem;
  padding: 0;
  margin-bottom: 1rem;
}

h2 {
  font-size: 1.5rem;
  margin-bottom: 1.5rem;
}

.stats-row {
  display: flex;
  gap: 1rem;
  margin-bottom: 2rem;
}

.stat-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 1rem;
  border-radius: 12px;
  background: var(--card-bg, #111827);
  border: 1px solid var(--border, #2d3748);
}

.stat-value {
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--primary, #00d4ff);
}

.stat-label {
  font-size: 0.8rem;
  color: var(--text-secondary, #a0aec0);
  margin-top: 0.25rem;
}

.checkin-btn {
  width: 100%;
  padding: 1rem;
  border-radius: 12px;
  border: none;
  background: var(--secondary, #ff9f4d);
  color: #0a0e1a;
  font-weight: 700;
  font-size: 1.1rem;
  cursor: pointer;
  transition: opacity 0.2s;
  font-family: inherit;
}

.checkin-btn.done {
  background: #38a169;
  color: #fff;
}

.checkin-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.checkin-tip {
  text-align: center;
  margin-top: 1.5rem;
  color: var(--text-secondary, #a0aec0);
  font-size: 0.9rem;
}

.checkin-tip a {
  color: var(--primary, #00d4ff);
  text-decoration: none;
}

.error-msg {
  color: #fc8181;
  margin-top: 1rem;
  text-align: center;
}
</style>
