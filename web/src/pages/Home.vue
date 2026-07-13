<script setup lang="ts">
import { useRouter } from 'vue-router'
const router = useRouter()
</script>

<template>
  <div class="home">
    <header class="hero">
      <h1>无言 AI 应援</h1>
      <p class="subtitle">为无言选手加油，AI 生成专属应援文案与卡片</p>
    </header>
    <nav class="entry-grid">
      <button class="entry-card cheer" @click="router.push('/cheer')">
        <span class="entry-icon">🎤</span>
        <span class="entry-label">AI 应援</span>
        <span class="entry-desc">选心情，生成应援文案与卡片</span>
      </button>
      <button class="entry-card checkin" @click="router.push('/checkin')">
        <span class="entry-icon">🔥</span>
        <span class="entry-label">每日打卡</span>
        <span class="entry-desc">一键加油，记录连续天数</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: 2rem;
}

.hero {
  text-align: center;
  margin-bottom: 3rem;
}

.hero h1 {
  font-size: 2rem;
  font-weight: 700;
  color: var(--text-primary, #fff);
  margin-bottom: 0.5rem;
}

.subtitle {
  color: var(--text-secondary, #a0aec0);
  font-size: 0.95rem;
}

.entry-grid {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  justify-content: center;
}

.entry-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 2rem 1.5rem;
  border-radius: 16px;
  border: 1px solid var(--border, #2d3748);
  background: var(--card-bg, #111827);
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  min-width: 180px;
  color: inherit;
  font-family: inherit;
}

.entry-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 20px rgba(0, 212, 255, 0.15);
}

.entry-icon {
  font-size: 2rem;
}

.entry-label {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary, #fff);
}

.entry-desc {
  font-size: 0.8rem;
  color: var(--text-secondary, #718096);
  text-align: center;
}
</style>
