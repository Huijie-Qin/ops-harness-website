<script setup lang="ts">
import ProductShot from './ProductShot.vue'
</script>

<template>
  <div class="product-showcase">
    <ProductShot
      src="/assets/product/goals-todos.jpg"
      alt="终端云工作助手的目标与待办界面示例：上方展示今日重点，下方汇集未来一周日历和最近 7 天邮件"
      caption="目标 · 待办 — 今日重点、日程与邮件"
      :width="1470"
      :height="980"
      eager
    />
    <p class="capture-note">界面示例 · 日程、邮件与重点事项均为演示内容</p>
  </div>
</template>

<style scoped>
.product-showcase{max-width:1120px;margin:auto}.capture-note{text-align:center;font-size:11px;color:var(--text-tertiary);margin:0}.product-showcase :deep(.product-shot>a){box-shadow:0 25px 70px -25px #1d29452b}
</style>
