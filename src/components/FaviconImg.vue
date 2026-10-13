<script setup lang="ts">
import { computed, ref } from 'vue';
import { faviconUrl } from '../shared/ui';

/**
 * 书签站点图标。Firefox 直接取站点 /favicon.ico，缺失/加载失败时整张隐藏，
 * 避免破图占位；视觉类（尺寸/圆角等）由调用方通过 class 透传。
 */
const props = defineProps<{
  /** 书签目标 URL，用于推导图标地址 */
  url: string;
  /** Chromium 内置 favicon 服务的请求尺寸，Firefox 分支不使用 */
  size?: number;
}>();

const failed = ref(false);
const src = computed(() => (props.url ? faviconUrl(props.url, props.size) : ''));
</script>

<template>
  <img v-if="src && !failed" :src="src" alt="" @error="failed = true" />
</template>
