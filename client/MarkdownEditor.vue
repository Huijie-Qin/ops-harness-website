<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import MediaLibrary from './MediaLibrary.vue'
import WebsiteDialog from './WebsiteDialog.vue'
import { uploadFile, imageMarkdown, requestMessage, ApiError, validateImage } from './guide-api'
import { maxImageBytes, type MediaImage } from '../shared/admin'
import { renderMarkdown } from '../shared/markdown'
const props = defineProps<{modelValue:string; documentKey:string; disabled?:boolean; csrf?:string}>()
const emit = defineEmits<{ 'update:modelValue':[value:string]; save:[]; busy:[value:boolean]; error:[e:unknown] }>()
const root = ref<HTMLElement>(), ready = ref(false), failed = ref(false)
const library=ref(false), uploadNotice=ref(''), uploading=ref(false), progress=ref(0)
let upload:AbortController|undefined
function insertImage(image:MediaImage,alt:string){library.value=false;editor?.insertValue('\n\n'+imageMarkdown(image.url,alt)+'\n\n');emit('update:modelValue',editor?.getValue()??props.modelValue)}
async function uploadImages(files:File[]){if(uploading.value||props.disabled)return '请等待当前操作完成';uploading.value=true;emit('busy',true);uploadNotice.value='';upload=new AbortController();const key=props.documentKey
try{for(const file of files){if(!file)throw new ApiError('INVALID_IMAGE');await validateImage(file);progress.value=0;const result=await uploadFile<{image:MediaImage}>('/api/admin/images?name='+encodeURIComponent(file.name),file,{csrf:props.csrf??'',signal:upload.signal,progress:v=>progress.value=v});if(key===props.documentKey&&!disposed)insertImage(result.image,file.name)}uploadNotice.value='图片已插入，保存章节后读者即可看到。';return ''}catch(e){if(!disposed){uploadNotice.value=upload.signal.aborted?'上传已取消。':requestMessage(e);if(!upload.signal.aborted)emit('error',e)}return uploadNotice.value}finally{uploading.value=false;emit('busy',false)}}
let editor: Vditor | undefined, disposed = false
let deadline: ReturnType<typeof setTimeout> | undefined
let narrow: MediaQueryList | undefined
function resizeEditor(){if(ready.value)editor?.setPreviewMode(narrow?.matches?'editor':'both')}
onMounted(() => {
  narrow=window.matchMedia('(max-width:699px)');narrow.addEventListener('change',resizeEditor)
  deadline = setTimeout(() => { if (!ready.value) failed.value = true }, 15000)
  try {
    editor = new Vditor(root.value!, {
      value:props.modelValue, mode:'sv', lang:'zh_CN', height:520, minHeight:380,
      cdn:'/assets/vendor/vditor-4.0.0', cache:{enable:false}, placeholder:'在这里编写章节正文…',
      toolbar:['headings','bold','italic','strike','|','list','ordered-list','check','quote','|','code','inline-code','link','upload','table','|','undo','redo','|','edit-mode','both','preview','fullscreen'],
      upload:{url:'/api/admin/images',accept:'image/png,image/jpeg,image/webp',max:maxImageBytes,multiple:true,handler:uploadImages},
      counter:{enable:true,type:'markdown'}, toolbarConfig:{pin:false},
      preview:{delay:200,mode:window.innerWidth<700?'editor':'both',actions:[],hljs:{enable:false},
        theme:{current:'light',path:'/assets/vendor/vditor-4.0.0/dist/css/content-theme'},
        markdown:{sanitize:true,codeBlockPreview:false,mathBlockPreview:false},render:{media:{enable:false}},
        transform:()=>renderMarkdown(editor?.getValue() ?? props.modelValue)},
      hint:{emoji:{}}, link:{isOpen:false}, image:{isPreview:false},
      input:value=>emit('update:modelValue',value),
      after:()=>{
        if (disposed) { editor?.destroy(); return }
        clearTimeout(deadline); ready.value=true
        if (props.disabled) editor?.disabled()
        for (const input of root.value?.querySelectorAll('[contenteditable]') ?? []) { input.setAttribute('role','textbox'); input.setAttribute('aria-label','章节正文'); input.setAttribute('aria-multiline','true') }
      },
    })
  } catch { failed.value=true }
})
watch(()=>[props.documentKey,props.modelValue] as const,([key,value],[previousKey])=>{ if(ready.value && (key!==previousKey||editor?.getValue()!==value)) editor?.setValue(value,true) })
watch(()=>props.disabled,value=>{ if(ready.value) value ? editor?.disabled() : editor?.enable() })
onBeforeUnmount(()=>{disposed=true;upload?.abort();emit('busy',false);clearTimeout(deadline);narrow?.removeEventListener('change',resizeEditor);editor?.destroy()})
</script>
<template><div class="markdown-editor" @keydown.ctrl.s.prevent="emit('save')" @keydown.meta.s.prevent="emit('save')"><p v-if="!ready && !failed" role="status">正在加载编辑器…</p><p v-if="failed" role="alert">编辑器加载失败，请检查连接后重新打开此页。</p><div class="image-tools"><button class="button secondary" :disabled="disabled||!ready||uploading" @click="library=true">从图片库插入</button><span>可直接粘贴、拖入图片，或使用工具栏上传</span><button v-if="uploading" @click="upload?.abort()">取消上传</button></div><p v-if="uploading" role="status">图片上传 {{progress}}%{{progress===100?'，正在保存…':''}}</p><p v-if="uploadNotice" role="status">{{uploadNotice}}</p><div ref="root" aria-label="Markdown 编辑器"></div><WebsiteDialog v-if="library" title="插入图片" message="选择图片后会插入正文当前位置。" confirm-label="完成" @cancel="library=false" @confirm="library=false"><MediaLibrary :csrf="csrf??''" selectable @select="insertImage" @error="emit('error',$event)" /></WebsiteDialog></div></template>
<style>.markdown-editor{min-width:0}.markdown-editor>.vditor{border-color:var(--border-default);border-radius:9px}.markdown-editor .vditor-toolbar{padding:5px!important;background:#f8f9fc;flex-wrap:wrap}.markdown-editor .vditor-reset{padding:18px!important;font-size:14px}.markdown-editor .markdown-copy{display:none}.markdown-editor .vditor-toolbar button{font-family:inherit}.markdown-editor .vditor-toolbar button:focus-visible{outline:2px solid var(--accent-primary)}.markdown-editor>p{font-size:12px;color:var(--text-secondary)}@media(max-width:700px){.markdown-editor .vditor-toolbar{overflow-x:auto}.markdown-editor .vditor-reset{font-size:13px}}</style>
