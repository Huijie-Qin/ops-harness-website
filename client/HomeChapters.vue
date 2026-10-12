<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { PhArrowDown, PhArrowUpRight } from '@phosphor-icons/vue'
import ProductionScene from './ProductionScene.vue'
import DataFlowScene from './DataFlowScene.vue'
import SkillFlowScene from './SkillFlowScene.vue'
import ModelScene from './ModelScene.vue'
import CollaborationScene from './CollaborationScene.vue'

const root = ref<HTMLElement>()
const active = ref(0)
const steps = reactive([0, 0, 0, 0])
const scrollScenes = ref(false)
const productionMode = ref<'data' | 'compliance'>('data')
const manual = new Map<number, { y: number }>()
const chapters = [
  { id: 'production', number: '01', title: '生产系统对接', english: 'CONNECTED TO YOUR BUSINESS', headline: '让专家，', emphasis: '进入真实业务。', description: '支持对接生产系统，完成终端云场景化专家的构建。从数据取数到合规执行，让专家接上业务的每一步。', color: '177, 158, 221', component: ProductionScene,
    steps: [ { title: '接收业务指令', text: '国家网信办指令，由总编室合规指令平台接收与下发。' }, { title: '总编室专家接手', text: '工作助手接收任务，连接指令与执行流程。' }, { title: '在业务系统中执行', text: '对接浏览器业务管理台：撤热榜、文章下线、网址屏蔽。' } ] },
  { id: 'skills', number: '02', title: '技能市场与分发', english: 'GOOD METHODS, SHARED', headline: '把好方法，', emphasis: '交给整个团队。', description: '产品运营 AI 市场与 Skill Hunt，汇集实用技能。专家与知识一键分发，让个人积累成为团队的共同能力。', color: '120, 191, 174', component: SkillFlowScene,
    steps: [ { title: '发现优质技能', text: 'Skill Hunt：全网优质 Skill 洞察精选，发现更多泛运营好技能。' }, { title: '按需获取，开始使用', text: '从选题、社群到直播，找到适合当前业务的技能。' }, { title: '让经验在团队流动', text: '专家按工号分发，Onebox 知识同步共享。' } ] },
  { id: 'models', number: '03', title: '模型资源池', english: 'POWER FOR EVERY EXPERT', headline: '专属算力，', emphasis: '支撑每位专家。', description: '面向业务的模型资源池，为不同场景提供能力支持。让专家有源可用，让工作持续向前。', color: '132, 173, 210', component: ModelScene,
    steps: [ { title: '申请与配置', text: '申请所需 Token，完成模型配置。' }, { title: '连接专属资源池', text: '汇聚面向业务的模型资源，提供专属算力。' }, { title: '支撑六类业务场景', text: '数据、PUSH、营销、合规、内容、质量，专家按需使用。' } ] },
  { id: 'collaboration', number: '04', title: '办公协同', english: 'FROM CONTEXT TO ACTION', headline: '看清今天，', emphasis: '推进下一步。', description: '打通 WeLink，连接日程、邮件与会议。从安排协同到生成 PPT，让日常工作顺畅推进。', color: '192, 172, 140', component: CollaborationScene,
    steps: [ { title: '汇集日程与邮件', text: '需要关注的信息，来到同一个工作空间。' }, { title: '整理今日重点', text: '结合日程与邮件，梳理值得优先处理的工作。' }, { title: '一句话，发起协同', text: '查联系人、建会议、发通知，带着上下文继续工作。' } ] },
]
const dataSteps = [
  { title: '先对齐指标口径', text: '连接云端指标知识库，明确 DAU、新增用户与留存口径。' },
  { title: '跨系统，多轮取数', text: 'DataAgent 查趋势、渠道与版本，DataOps 查活动和投放排期。' },
  { title: '交叉归因，形成判断', text: '把业务数据与运营动作放在一起，看清变化背后的原因。' },
]
const productionScene = computed(() => productionMode.value === 'data' ? DataFlowScene : ProductionScene)
const stepList = (index: number) => index === 0 && productionMode.value === 'data' ? dataSteps : chapters[index]!.steps
function selectStep(index: number, step: number) {
  steps[index] = step
  manual.set(index, { y: window.scrollY })
}
function selectProduction(mode: 'data' | 'compliance') {
  productionMode.value = mode
  selectStep(0, 0)
}
let dispose = () => {}
onMounted(() => {
  const host = root.value!
  const sections = [...host.querySelectorAll<HTMLElement>('.scene-chapter')]
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const compact = window.matchMedia('(max-width: 1000px), (max-height: 700px)')
  const animations = new Set<Animation>()
  let frame = 0
  let disposed = false
  const update = () => {
    frame = 0
    if (disposed) return
    const height = window.innerHeight
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index]!
      const rect = section.getBoundingClientRect()
      if (rect.top < height * .45 && rect.bottom > height * .45) active.value = index
      if (!scrollScenes.value || rect.bottom < 0 || rect.top > height) continue
      const selected = manual.get(index)
      if (selected && Math.abs(window.scrollY - selected.y) < 120) continue
      manual.delete(index)
      const stage = section.querySelector<HTMLElement>('.chapter-stage')!
      const top = Number.parseFloat(getComputedStyle(stage).top) || 90
      const travel = Math.max(1, rect.height - stage.offsetHeight - top)
      const progress = Math.max(0, Math.min(1, (top - rect.top) / travel))
      steps[index] = Math.min(2, Math.floor(progress * 3))
    }
  }
  const schedule = () => { if (!frame && !disposed) frame = window.requestAnimationFrame(update) }
  const configure = () => {
    scrollScenes.value = !reduced.matches && !compact.matches
    if (reduced.matches) { animations.forEach(animation => animation.cancel()); animations.clear() }
    schedule()
  }
  const reveal = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      reveal.unobserve(entry.target)
      if (reduced.matches || typeof entry.target.animate !== 'function') continue
      const animation = entry.target.animate([
        { opacity: .18, transform: 'translateY(48px) scale(.98)', filter: 'blur(5px)' },
        { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0px)' },
      ], { duration: 1050, easing: 'cubic-bezier(.16,.7,.2,1)' })
      animations.add(animation)
      animation.onfinish = () => animations.delete(animation)
    }
  }, { threshold: .15 })
  host.querySelectorAll('.scene-reveal').forEach(element => reveal.observe(element))
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', configure, { passive: true })
  reduced.addEventListener('change', configure)
  compact.addEventListener('change', configure)
  configure()
  dispose = () => {
    disposed = true
    window.cancelAnimationFrame(frame)
    reveal.disconnect()
    animations.forEach(animation => animation.cancel()); animations.clear()
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', configure)
    reduced.removeEventListener('change', configure)
    compact.removeEventListener('change', configure)
    manual.clear()
  }
})
onBeforeUnmount(() => dispose())
</script>

<template>
  <section id="product" ref="root" class="home-chapters" :class="{'scroll-scenes':scrollScenes}" aria-labelledby="chapters-title">
    <div class="story-intro story-shell scene-reveal">
      <p class="story-kicker">从业务现场，到日常工作</p>
      <h2 id="chapters-title">不止于回答。<br/><span>让工作，真正向前。</span></h2>
      <p>连接系统、沉淀能力、汇聚算力、推进协同。<br/>四种能力，在同一个工作空间发生。</p>
      <span class="scroll-hint"><PhArrowDown :size="16" weight="light"/> 向下探索，展开每一步</span>
    </div>
    <nav class="chapter-nav" aria-label="产品能力章节"><div class="story-shell"><a v-for="(chapter,index) in chapters" :key="chapter.id" :href="`#${chapter.id}`" :aria-current="active===index?'location':undefined"><span>{{ chapter.number }}</span>{{ chapter.title }}</a></div></nav>
    <article v-for="(chapter,index) in chapters" :key="chapter.id" :id="chapter.id" class="scene-chapter" :style="{'--chapter-color':chapter.color}" :aria-labelledby="`${chapter.id}-title`">
      <div class="chapter-stage story-shell">
        <div class="chapter-copy scene-reveal">
          <p class="chapter-label"><span>{{ chapter.number }}</span>{{ chapter.title }}</p>
          <h2 :id="`${chapter.id}-title`">{{ chapter.headline }}<br/><span>{{ chapter.emphasis }}</span></h2>
          <p class="chapter-description">{{ chapter.description }}</p>
          <div class="scene-steps" :aria-label="`${chapter.title}演示步骤`" role="group">
            <button v-for="(step,stepIndex) in stepList(index)" :key="step.title" :aria-pressed="steps[index]===stepIndex" :aria-controls="`${chapter.id}-scene`" @click="selectStep(index,stepIndex)"><span class="step-number">{{ String(stepIndex+1).padStart(2,'0') }}</span><span><strong>{{ step.title }}</strong><span class="step-description">{{ step.text }}</span></span></button>
          </div>
          <a v-if="chapter.id==='models'" class="chapter-guide" href="/guide#models">了解模型配置<PhArrowUpRight :size="15"/></a>
        </div>
        <div class="story-visual scene-reveal" :id="`${chapter.id}-scene`">
          <div class="visual-topline"><span>{{ chapter.english }}</span><div v-if="index===0" class="scene-selector" role="group" aria-label="生产系统演示场景"><button :aria-pressed="productionMode==='data'" @click="selectProduction('data')">数据分析</button><button :aria-pressed="productionMode==='compliance'" @click="selectProduction('compliance')">内容合规</button></div><span v-else class="scene-indicator">{{ String(steps[index]!+1).padStart(2,'0') }} <span>/ 03</span></span></div>
          <div class="scene-surface"><component :is="index===0?productionScene:chapter.component" :step="steps[index] ?? 0"/></div>
          <div class="visual-caption"><span>场景演示 · 基于产品宣传片</span><span>{{ scrollScenes ? '滚动展开 · 也可点击步骤' : '点击步骤，展开演示' }}</span></div>
        </div>
      </div>
    </article>
    <div class="story-end story-shell"><span>业务相连，能力共享。</span><p>现在，把这些能力带到你的桌面。</p><PhArrowDown :size="25" weight="light"/></div>
  </section>
</template>

<style scoped>
:global(html:has(.home-chapters)){scroll-padding-top:0}
.home-chapters{background:#080f17;color:#edf0f4;scroll-margin-top:0;overflow:clip}
.story-shell{width:min(1320px,90vw);margin-inline:auto}
.story-intro{text-align:center;padding:150px 0 130px;position:relative}
.story-kicker{font-size:11px;letter-spacing:.2em;color:#728296;margin:0 0 33px}
.story-intro h2{font-size:clamp(40px,4.8vw,68px);font-weight:500;letter-spacing:-.055em;line-height:1.25;margin:0}.story-intro h2>span{color:#b8c6d8}
.story-intro>p:not(.story-kicker){color:#8291a5;font-size:15px;line-height:1.9;margin:31px 0 0}.scroll-hint{display:inline-flex;gap:12px;align-items:center;font-size:10px;letter-spacing:.09em;color:#5f7288;margin-top:52px}
.chapter-nav{position:sticky;top:0;z-index:7;border-block:1px solid #b4c6dc18;background:#080f17eb;backdrop-filter:blur(20px)}
.chapter-nav>.story-shell{display:grid;grid-template-columns:repeat(4,1fr)}
.chapter-nav a{position:relative;display:flex;align-items:center;gap:16px;min-height:65px;color:#7b8a9d;font-size:12px;text-decoration:none;transition:color .35s}.chapter-nav a>span{font-size:9px;color:#5d7189;font-variant-numeric:tabular-nums}.chapter-nav a::after{position:absolute;content:'';height:1px;background:#c6d3e3;inset:auto 30px -1px 0;transform:scaleX(0);transform-origin:left;transition:transform .5s}.chapter-nav a:hover,.chapter-nav a[aria-current]{color:#e5eaf1}.chapter-nav a[aria-current]::after{transform:scaleX(1)}
.scene-chapter{position:relative;scroll-margin-top:65px;padding:95px 0 115px;border-bottom:1px solid #b4c6dc12}
.chapter-stage{display:grid;grid-template-columns:minmax(285px,.85fr) minmax(0,1.85fr);gap:6%;align-items:center;position:relative}
.chapter-copy{position:relative;z-index:2}.chapter-label{display:flex;align-items:center;gap:15px;font-size:11px;color:#8a99ae;letter-spacing:.08em;margin:0 0 25px}.chapter-label>span{font-size:10px;color:rgb(var(--chapter-color));font-variant-numeric:tabular-nums}
.chapter-copy h2{font-size:clamp(33px,3.3vw,47px);letter-spacing:-.045em;font-weight:500;line-height:1.35;margin:0}.chapter-copy h2>span{color:#b7c3d1}
.chapter-description{font-size:14px;line-height:1.95;color:#8292a7;margin:23px 0 28px;max-width:370px}
.scene-steps{display:flex;flex-direction:column;gap:0}.scene-steps button{width:100%;font:inherit;text-align:left;display:flex;align-items:flex-start;gap:14px;padding:16px 0;color:#8292a7;background:none;border:0;border-top:1px solid #a1b5d017;cursor:pointer;transition:color .4s;position:relative}.scene-steps button::before{content:'';width:2px;background:rgb(var(--chapter-color));position:absolute;left:-15px;top:17px;bottom:17px;opacity:0;transform:scaleY(.4);transition:opacity .4s,transform .4s}.scene-steps button[aria-pressed=true]::before{opacity:1;transform:scaleY(1)}.scene-steps button[aria-pressed=true]{color:#e0e6ee}.step-number{color:#50637c;font-size:10px;line-height:21px;transition:color .4s}.scene-steps button[aria-pressed=true] .step-number{color:rgb(var(--chapter-color))}.scene-steps strong{font-size:13px;font-weight:400;line-height:1.5;display:block}.step-description{font-size:11px;line-height:1.7;display:block;color:#8292a7;margin-top:6px;transition:color .4s}.scene-steps button[aria-pressed=true] .step-description{color:#9cabbf}.scene-steps button:hover strong{color:#edf2f8}
.chapter-guide{display:inline-flex;align-items:center;gap:12px;font-size:11px;color:#99b5ce;text-decoration:none;margin-top:20px;padding:4px 0;border-bottom:1px solid #91aec84d}
.story-visual{min-width:0;position:relative;isolation:isolate}.story-visual::before{position:absolute;content:'';inset:5% -6% -9%;z-index:-1;background:radial-gradient(ellipse at 50% 52%,rgba(var(--chapter-color),.085),rgba(var(--chapter-color),.018) 48%,transparent 70%);pointer-events:none}
.visual-topline{min-height:42px;display:flex;align-items:center;justify-content:space-between;gap:15px;border-bottom:1px solid #b3c4df1b;color:#536a84;font-size:8px;letter-spacing:.14em;padding:0 15px 12px}.visual-topline>span:first-child{white-space:nowrap}.scene-indicator{color:rgb(var(--chapter-color));font-variant-numeric:tabular-nums;font-size:11px;letter-spacing:.06em}.scene-indicator>span{color:#425773;margin-left:6px}
.scene-selector{display:flex;gap:5px}.scene-selector button{font:inherit;font-size:10px;letter-spacing:0;border:1px solid transparent;border-radius:5px;background:transparent;color:#6c7d94;padding:7px 12px;cursor:pointer;transition:background .3s,color .3s,border-color .3s}.scene-selector button[aria-pressed=true]{background:#b3a0dc10;border-color:#b3a0dc33;color:#cbbde7}.scene-selector button:hover{color:#eee7fa}
.scene-surface{width:100%;min-width:0;position:relative}.visual-caption{display:flex;align-items:center;justify-content:space-between;gap:15px;font-size:9px;color:#8392a6;padding:19px 15px 0;border-top:1px solid #b3c4df16}
.scroll-scenes .scene-chapter{min-height:max(1050px,160svh);padding:0 0 90px;box-sizing:border-box}.scroll-scenes .chapter-stage{position:sticky;top:95px;padding-top:35px;min-height:min(660px,calc(100svh - 125px));box-sizing:border-box}
.story-end{text-align:center;padding:90px 0 75px;color:#728399}.story-end>span{font-size:11px;letter-spacing:.12em}.story-end>p{font-size:clamp(22px,2.7vw,36px);font-weight:400;color:#aebdce;letter-spacing:-.035em;margin:22px 0 35px}.story-end>svg{color:#6b8099}
.home-chapters a:focus-visible,.home-chapters button:focus-visible{outline:2px solid #c4d5e8;outline-offset:5px}
@media(max-width:1200px){.chapter-stage{gap:4%;grid-template-columns:290px minmax(0,1fr)}.chapter-copy h2{font-size:36px}.chapter-description{font-size:13px}.scene-steps button{padding-block:13px}.visual-topline{padding-inline:8px;gap:8px}.visual-topline>span:first-child{font-size:7px;letter-spacing:.07em}.scene-selector button{padding:6px 8px}.scroll-scenes .chapter-stage{padding-top:15px;top:85px}}
@media(max-width:1000px){.story-intro{padding:110px 0 95px}.chapter-stage{grid-template-columns:1fr;gap:38px}.chapter-copy{max-width:none}.chapter-copy h2{font-size:43px}.chapter-description{max-width:640px}.scene-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:25px}.scene-steps button{border-top:1px solid #a1b5d033;padding-top:15px;gap:10px}.scene-steps button::before{left:0;right:0;top:-1px;bottom:auto;height:2px;width:auto;transform:scaleX(.4)}.scene-steps button[aria-pressed=true]::before{transform:scaleX(1)}.step-description{font-size:11px}.story-visual{max-width:800px;width:100%;margin:auto}.scene-chapter{padding:80px 0 95px}.visual-topline>span:first-child{font-size:9px;letter-spacing:.1em}.chapter-guide{margin-top:15px}}
@media(max-height:800px) and (min-width:1001px){.scroll-scenes .chapter-stage{top:77px;padding-top:10px;min-height:0}.chapter-copy h2{font-size:36px}.chapter-description{font-size:12px;margin-block:18px 20px}.chapter-label{margin-bottom:18px}.scene-steps button{padding-block:11px}.visual-topline{min-height:28px;padding-bottom:8px}.visual-caption{padding-top:12px}}
@media(max-width:700px){.story-shell{width:90vw}.story-intro{padding:88px 0 75px}.story-kicker{font-size:10px;margin-bottom:25px}.story-intro h2{font-size:38px;line-height:1.35}.story-intro>p:not(.story-kicker){font-size:12px;line-height:1.9;margin-top:25px}.scroll-hint{margin-top:35px;font-size:9px}.chapter-nav a{min-height:60px;flex-direction:column;align-items:flex-start;justify-content:center;gap:4px;font-size:10px;white-space:nowrap}.chapter-nav a>span{font-size:9px}.chapter-nav a::after{right:12px}.scene-chapter{padding:64px 0 75px;scroll-margin-top:60px}.chapter-stage{gap:28px}.chapter-label{font-size:10px;margin-bottom:20px}.chapter-copy h2{font-size:35px}.chapter-description{font-size:13px;margin:20px 0 25px;line-height:1.9}.scene-steps{gap:14px}.scene-steps button{gap:0;flex-direction:column;padding:10px 0}.step-number{font-size:9px;margin-bottom:6px}.scene-steps strong{font-size:11px}.step-description{font-size:10px;line-height:1.65;margin-top:7px}.scene-steps button:not([aria-pressed=true]) .step-description{color:#8292a7}.visual-topline{padding:0 3px 12px;gap:8px}.visual-topline>span:first-child{font-size:7px;letter-spacing:.04em}.scene-selector button{font-size:10px;padding:6px 7px}.visual-caption{font-size:8px;gap:8px;padding-inline:4px}.story-end{padding:60px 0 65px}.story-end>p{font-size:23px;line-height:1.7}.story-end>span{font-size:10px}}
@media(prefers-reduced-motion:reduce){.home-chapters *{transition:none!important;scroll-behavior:auto!important}}
</style>
