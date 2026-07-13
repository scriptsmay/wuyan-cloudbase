import { createRouter, createWebHistory } from 'vue-router'
import Home from '../pages/Home.vue'
import Cheer from '../pages/Cheer.vue'
import Checkin from '../pages/Checkin.vue'

const routes = [
  { path: '/', name: 'home', component: Home },
  { path: '/cheer', name: 'cheer', component: Cheer },
  { path: '/checkin', name: 'checkin', component: Checkin },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
