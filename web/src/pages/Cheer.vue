<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const moods = [
  { key: 'victory', label: '胜利', emoji: '🏆', color: '#f0c040' },
  { key: 'low', label: '低谷', emoji: '💜', color: '#9f7aea' },
  { key: 'daily', label: '日常', emoji: '💙', color: '#00d4ff' },
  { key: 'hope', label: '求胜', emoji: '❤️', color: '#fc8181' },
] as const

const selectedMood = ref<string | null>(null)
const customText = ref('')
const loading = ref(false)
const result = ref<{ lines: string[]; emoji_caption: string } | null>(null)
const error = ref<string | null>(null)

async function generate() {
  if (!selectedMood.value) return
  loading.value = true
  error.value = null
  try {
    // TODO: 替换为真实 CloudBase API 调用
    await new Promise(r => setTimeout(r, 800))
    const mock: Record<string, { lines: string[]; emoji_caption: string }> = {
      victory: { lines: ['冠军之姿，无人能挡！🏆', '无言加油，你是最棒的！'], emoji_caption: '胜利的喜悦 🎉' },
      low: { lines: ['低谷只是暂时的，强者永远向前！💜', '每一次跌倒都是为了更好的起飞'], emoji_caption: '挺住 💪' },
      daily: { lines: ['日复一日的坚持，终将绽放光芒 ✨', '无言，我们一直都在'], emoji_caption: '陪伴是最长情的告白 💙' },
      hope: { lines: ['必胜的信念，燃烧吧！🔥', '这一战，我们必胜！'], emoji_caption: '全力争胜 ❤️' },
    }
    result.value = mock[selectedMood.value]
  } catch {
    error.value = '生成失败，请重试'
  } finally {
    loading.value = false
  }
}
function copyText(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {
    // fallback: select text
  })
}
</script>

<template>
  <div class="cheer-page">
    <button class="back-btn" @click="router.push('/')">← 返回</button>
    <h2>AI 应援文案</h2>

    <!-- 心情选择 -->
    <div class="mood-grid">
      <button
        v-for="m in moods"
        :key="m.key"
        class="mood-btn"
        :class="{ selected: selectedMood === m.key }"
        :style="{ '--mood-color': m.color }"
        @click="selectedMood = m.key"
      >
        <span class="mood-emoji">{{ m.emoji }}</span>
        <span class="mood-label">{{ m.label }}</span>
      </button>
    </div>

    <textarea
      v-model="customText"
      class="custom-input"
      placeholder="想对无言说的话（可选，最多 120 字）"
      maxlength="120"
      rows="3"
    />

    <button
      class="generate-btn"
      :disabled="!selectedMood || loading"
      @click="generate"
    >
      {{ loading ? '生成中...' : '✨ 生成应援文案' }}
    </button>

    <!-- 结果 -->
    <div v-if="result" class="result-card">
      <p v-for="(line, i) in result.lines" :key="i" class="cheer-line">{{ line }}</p>
      <p class="emoji-caption">{{ result.emoji_caption }}</p>
      <div class="result-actions">
        <button class="action-btn" @click="copyText(result.lines.join('\n'))">
          📋 复制文案
        </button>
      </div>
    </div>

    <p v-if="error" class="error-msg">{{ error }}</p>
  </div>
</template>

<style scoped>
.cheer-page {
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

.mood-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.mood-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  padding: 1rem 0.5rem;
  border-radius: 12px;
  border: 2px solid var(--border, #2d3748);
  background: var(--card-bg, #111827);
  cursor: pointer;
  transition: all 0.2s;
  color: inherit;
  font-family: inherit;
}

.mood-btn.selected {
  border-color: var(--mood-color);
  background: color-mix(in srgb, var(--mood-color) 15%, transparent);
}

.mood-emoji {
  font-size: 1.5rem;
}

.mood-label {
  font-size: 0.8rem;
  font-weight: 600;
}

.custom-input {
  width: 100%;
  padding: 0.75rem;
  border-radius: 12px;
  border: 1px solid var(--border, #2d3748);
  background: var(--card-bg, #111827);
  color: var(--text-primary, #fff);
  resize: vertical;
  font-family: inherit;
  font-size: 0.9rem;
  margin-bottom: 1rem;
  box-sizing: border-box;
}

.generate-btn {
  width: 100%;
  padding: 0.85rem;
  border-radius: 12px;
  border: none;
  background: var(--primary, #00d4ff);
  color: #0a0e1a;
  font-weight: 700;
  font-size: 1rem;
  cursor: pointer;
  transition: opacity 0.2s;
  font-family: inherit;
}

.generate-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.result-card {
  margin-top: 1.5rem;
  padding: 1.5rem;
  border-radius: 16px;
  background: var(--card-bg, #111827);
  border: 1px solid var(--border, #2d3748);
}

.cheer-line {
  font-size: 1.05rem;
  line-height: 1.8;
  color: var(--text-primary, #fff);
  margin: 0 0 0.5rem;
}

.emoji-caption {
  color: var(--text-secondary, #a0aec0);
  font-size: 0.9rem;
  margin: 0.75rem 0;
}

.result-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
}

.action-btn {
  padding: 0.5rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--border, #2d3748);
  background: var(--card-bg, #1a202c);
  color: var(--text-primary, #fff);
  cursor: pointer;
  font-size: 0.85rem;
  font-family: inherit;
  transition: border-color 0.2s;
}

.action-btn:hover {
  border-color: var(--primary, #00d4ff);
}

.error-msg {
  color: #fc8181;
  margin-top: 1rem;
  text-align: center;
}
</style>
