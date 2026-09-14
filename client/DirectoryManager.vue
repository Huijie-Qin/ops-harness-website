<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NavigationDocument } from '../shared/admin'
import type { ChapterSummary } from '../shared/guide'

const props = defineProps<{ navigation: NavigationDocument; chapters: ChapterSummary[]; busy: boolean }>()
const emit = defineEmits<{ edit: [id: string]; action: [type: string, id: string, groupId: string] }>()
const filter = ref(''), trash = ref(false)
const groups = computed(() => props.navigation.groups.map((group, index) => ({
  ...group, index,
  documents: group.chapters.map((id, position) => ({ chapter: props.chapters.find(c => c.id === id), position }))
    .filter((item): item is { chapter: ChapterSummary; position: number } => !!item.chapter
      && item.chapter.archived === trash.value
      && `${item.chapter.title} ${group.title}`.toLowerCase().includes(filter.value.trim().toLowerCase())),
})).filter(group => group.documents.length || (!trash.value && group.title.toLowerCase().includes(filter.value.trim().toLowerCase()))))
</script>

<template>
  <section class="directory-manager" aria-labelledby="directory-manager-title" :aria-busy="busy">
    <div class="management-heading">
      <div><h2 id="directory-manager-title">目录与文档管理</h2><p>管理文档名称、简介、归属和阅读顺序。修改后立即生效。</p></div>
      <button class="button primary" :disabled="busy || !navigation.revision" @click="emit('action', 'create-directory', '', '')">新建目录</button>
    </div>
    <div class="management-filters">
      <label for="management-filter">查找目录或文档<input id="management-filter" v-model="filter" type="search" placeholder="输入目录或文档名称" /></label>
      <div class="admin-tabs" role="group" aria-label="文档状态"><button :aria-pressed="!trash" :disabled="busy" @click="trash = false">使用中的文档</button><button :aria-pressed="trash" :disabled="busy" @click="trash = true">回收站</button></div>
    </div>
    <section v-for="group in groups" :key="group.id" class="management-group" :aria-labelledby="`directory-${group.id}`">
      <div class="management-group-heading">
        <div><h3 :id="`directory-${group.id}`">{{ group.title }}</h3><p>{{ group.documents.length }} 篇{{ trash ? '已回收文档' : '文档' }}</p></div>
        <div class="admin-actions" role="group" :aria-label="`${group.title} 的目录操作`">
          <button class="button secondary" :disabled="busy" @click="emit('action', 'create-document', '', group.id)">新建文档</button>
          <button class="management-action" :disabled="busy" @click="emit('action', 'rename-directory', group.id, group.id)">重命名目录</button>
          <button class="management-action" :disabled="busy || group.index === 0" @click="emit('action', 'directory-up', group.id, group.id)">上移目录</button>
          <button class="management-action" :disabled="busy || group.index === navigation.groups.length - 1" @click="emit('action', 'directory-down', group.id, group.id)">下移目录</button>
          <button class="management-action danger" :disabled="busy || group.chapters.length > 0" :title="group.chapters.length ? '先移出全部文档，包括回收站中的文档' : undefined" @click="emit('action', 'delete-directory', group.id, group.id)">删除空目录</button>
        </div>
      </div>
      <ul class="managed-documents" :aria-label="`${group.title} 的文档`">
        <li v-for="{ chapter, position } in group.documents" :key="chapter.id" :aria-label="chapter.title">
          <div class="managed-document-details"><strong>{{ chapter.title }}</strong><span v-if="chapter.archived" class="document-status">已回收</span><span v-else-if="navigation.hidden.includes(chapter.id)" class="document-status">目录中隐藏</span><p>{{ chapter.summary || '暂无简介' }}</p></div>
          <div class="admin-actions" role="group" :aria-label="`${chapter.title} 的文档操作`">
            <button v-if="!trash" class="management-action edit-document" :disabled="busy" @click="emit('edit', chapter.id)">编辑正文</button>
            <button v-if="!trash" class="management-action" :disabled="busy" @click="emit('action', 'edit-document', chapter.id, group.id)">名称与简介</button>
            <button class="management-action" :disabled="busy || navigation.groups.length < 2" @click="emit('action', 'move-document', chapter.id, group.id)">移动</button>
            <button class="management-action" :disabled="busy || position === 0" @click="emit('action', 'document-up', chapter.id, group.id)">上移</button>
            <button class="management-action" :disabled="busy || position === group.chapters.length - 1" @click="emit('action', 'document-down', chapter.id, group.id)">下移</button>
            <button v-if="!trash" class="management-action" :disabled="busy" @click="emit('action', 'toggle-visibility', chapter.id, group.id)">{{ navigation.hidden.includes(chapter.id) ? '显示在目录' : '从目录隐藏' }}</button>
            <button class="management-action" :class="{ danger: !trash }" :disabled="busy" @click="emit('action', 'archive-document', chapter.id, group.id)">{{ trash ? '恢复文档' : '移至回收站' }}</button>
          </div>
        </li>
      </ul>
      <p v-if="!group.documents.length" class="management-empty">{{ filter ? '此目录没有匹配的文档。' : '此目录暂无文档，点击“新建文档”开始。' }}</p>
    </section>
    <p v-if="!groups.length" class="admin-empty">{{ filter ? '没有匹配的目录或文档。' : trash ? '回收站为空。' : '还没有目录，点击“新建目录”开始。' }}</p>
    <p class="editor-help">隐藏只影响阅读目录和搜索，原链接仍可访问；移至回收站后停止公开。目录仅支持“目录 → 文档”两级。</p>
  </section>
</template>
