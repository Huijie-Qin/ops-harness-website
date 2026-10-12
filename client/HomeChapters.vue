<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PhArrowUpRight } from '@phosphor-icons/vue'

const root = ref<HTMLElement>()
const active = ref('production')
const productionView = ref<'experts' | 'compliance'>('experts')
const chapters = [
  { id: 'production', number: '01', title: '生产系统对接' },
  { id: 'skills', number: '02', title: '技能市场与分发' },
  { id: 'models', number: '03', title: '模型资源池' },
  { id: 'collaboration', number: '04', title: '办公协同' },
]
const production = computed(() => productionView.value === 'experts' ? {
  image: 'experts',
  alt: '宣传片中的终端云场景化专家总览：数据分析、PUSH、生态营销、总编室、内容合作和质量运营六类专家',
  caption: '数据分析、PUSH、生态营销、总编室、内容合作、质量运营，六类专家按需上岗。',
} : {
  image: 'compliance',
  alt: '总编室对接示例：国家网信办指令经总编室合规指令平台下发至工作助手，再在浏览器业务管理台完成执行',
  caption: '从合规指令平台接收任务，到浏览器业务管理台完成执行。',
})
const asset = (name: string, size = 1800) => `/assets/product/chapters/${name}-${size}.webp`
let dispose = () => {}

onMounted(() => {
  const host = root.value!
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const animations = new Set<Animation>()
  // Content is visible by default; enhancement failure must never hide a chapter.
  const reveal = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      reveal.unobserve(entry.target)
      if (reduced.matches || typeof entry.target.animate !== 'function') continue
      const animation = entry.target.animate([
        { opacity: .45, transform: 'translateY(20px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 650, easing: 'cubic-bezier(.2,.65,.3,1)' })
      animations.add(animation)
      animation.onfinish = () => animations.delete(animation)
    }
  }, { threshold: .12 })
  const chapterElements = host.querySelectorAll('.story-chapter')
  let current: IntersectionObserver | undefined
  let resizeFrame = 0
  const observeCurrent = () => {
    current?.disconnect()
    const height = Math.max(1, window.innerHeight)
    // Percentage root margins use viewport width, including the vertical margins.
    current = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) active.value = entry.target.id
    }, { rootMargin: `-${Math.round(height * .12)}px 0px -${Math.round(height * .65)}px 0px`, threshold: 0 })
    chapterElements.forEach(element => current!.observe(element))
  }
  const resizeCurrent = () => {
    if (resizeFrame) return
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0
      observeCurrent()
    })
  }
  host.querySelectorAll('.chapter-reveal').forEach(element => reveal.observe(element))
  observeCurrent()
  window.addEventListener('resize', resizeCurrent, { passive: true })
  const stopMotion = () => {
    if (reduced.matches) { animations.forEach(animation => animation.cancel()); animations.clear() }
  }
  reduced.addEventListener('change', stopMotion)
  dispose = () => {
    reveal.disconnect(); current?.disconnect()
    window.cancelAnimationFrame(resizeFrame)
    window.removeEventListener('resize', resizeCurrent)
    animations.forEach(animation => animation.cancel()); animations.clear()
    reduced.removeEventListener('change', stopMotion)
  }
})
onBeforeUnmount(() => dispose())
</script>

<template>
  <section id="product" ref="root" class="home-chapters" aria-labelledby="chapters-title">
    <div class="chapters-intro chapter-shell chapter-reveal">
      <p class="story-eyebrow">从业务现场，到日常工作</p>
      <h2 id="chapters-title">让能力相连。<br /><span>让每一步，都向前。</span></h2>
      <p class="story-lead">连接生产系统，汇聚技能与知识。<br class="desktop-break" />让专属模型与办公协同，进入同一个工作空间。</p>
    </div>

    <nav class="chapter-nav" aria-label="产品能力章节">
      <div class="chapter-shell">
        <a v-for="chapter in chapters" :key="chapter.id" :href="`#${chapter.id}`" :aria-current="active === chapter.id ? 'location' : undefined">
          <span>{{ chapter.number }}</span><span>{{ chapter.title }}</span>
        </a>
      </div>
    </nav>

    <div class="chapter-shell">
      <article id="production" class="story-chapter chapter-production" aria-labelledby="production-title">
        <header class="chapter-heading chapter-reveal">
          <div><p class="story-eyebrow"><span>01</span> 生产系统对接</p><h2 id="production-title">连接生产系统。<br /><span>构建终端云场景化专家。</span></h2></div>
          <p class="chapter-description">从取数、分析到内容合规，把业务系统与专家能力接在一起，让工作助手进入真实的生产流程。</p>
        </header>
        <div class="chapter-reveal">
          <div class="chapter-view-switch" role="group" aria-label="生产系统展示">
            <button :aria-pressed="productionView === 'experts'" aria-controls="production-visual" @click="productionView = 'experts'">六类场景化专家</button>
            <button :aria-pressed="productionView === 'compliance'" aria-controls="production-visual" @click="productionView = 'compliance'">总编室对接示例</button>
          </div>
          <figure id="production-visual" class="chapter-figure production-figure">
            <div class="chapter-screen production-screen"><img :key="production.image" :src="asset(production.image)" :srcset="`${asset(production.image, 900)} 900w, ${asset(production.image)} 1800w`" sizes="(max-width: 700px) 90vw, (max-width: 1440px) 90vw, 1280px" :alt="production.alt" width="1800" :height="productionView === 'experts' ? 1184 : 1052" loading="lazy" decoding="async" /></div>
            <figcaption><span>{{ production.caption }}</span><a :href="asset(production.image)" target="_blank" rel="noopener" :aria-label="`${productionView === 'experts' ? '场景化专家' : '总编室对接'}，在新标签页查看大图`">查看大图<PhArrowUpRight :size="15" /></a></figcaption>
          </figure>
        </div>
        <div class="chapter-footnotes chapter-reveal"><p><strong>系统相连</strong><span>DataAgent、DataOps 等生产能力接入工作流。</span></p><p><strong>专家就位</strong><span>围绕六类业务场景，组织专门的能力。</span></p><p><strong>指令落地</strong><span>总编室指令下发、执行与风险提示。</span></p></div>
      </article>

      <article id="skills" class="story-chapter chapter-split" aria-labelledby="skills-title">
        <div class="chapter-copy chapter-reveal">
          <p class="story-eyebrow"><span>02</span> 技能市场与分发</p>
          <h2 id="skills-title">好能力，<br /><span>让团队共享。</span></h2>
          <p class="chapter-description">技能、专家、知识，一键获取。把个人积累的好方法，变成团队可复用的工作能力。</p>
          <dl class="chapter-details"><div><dt>产品运营 AI 市场</dt><dd>面向业务场景，发现与获取所需技能。</dd></div><div><dt>Skill Hunt</dt><dd>全网优质 Skill 洞察精选，发现更多泛运营好技能。</dd></div><div><dt>专家与知识分发</dt><dd>专家按工号分发，Onebox 知识随时同步。</dd></div></dl>
        </div>
        <figure class="chapter-figure chapter-reveal"><div class="chapter-screen"><img :src="asset('skills')" :srcset="`${asset('skills', 900)} 900w, ${asset('skills')} 1800w`" sizes="(max-width: 900px) 90vw, 60vw" alt="宣传片中的 Skill Hunt 技能市场，展示热点选题雷达、社群运营话术、直播脚本助手等技能" width="1800" height="1060" loading="lazy" decoding="async" /></div><figcaption><span>发现 · 获取 · 分发</span><a :href="asset('skills')" target="_blank" rel="noopener" aria-label="技能市场，在新标签页查看大图">查看大图<PhArrowUpRight :size="15" /></a></figcaption></figure>
      </article>

      <article id="models" class="story-chapter chapter-split chapter-reverse" aria-labelledby="models-title">
        <div class="chapter-copy chapter-reveal">
          <p class="story-eyebrow"><span>03</span> 模型资源池</p>
          <h2 id="models-title">专属模型资源。<br /><span>支撑每一位专家。</span></h2>
          <p class="chapter-description">汇聚面向业务的模型资源，为不同场景的专家提供算力支持，让能力有源可用。</p>
          <dl class="chapter-details"><div><dt>专属算力</dt><dd>模型资源池连接数据、营销、内容等业务专家。</dd></div><div><dt>Token 申请与配置</dt><dd>申请所需 Token，完成配置后开始使用。</dd></div></dl>
          <a class="chapter-link" href="/guide#models">了解模型配置<PhArrowUpRight :size="18" /></a>
        </div>
        <figure class="chapter-figure chapter-reveal"><div class="chapter-screen"><img :src="asset('models')" :srcset="`${asset('models', 900)} 900w, ${asset('models')} 1800w`" sizes="(max-width: 900px) 90vw, 60vw" alt="宣传片中的模型资源池示意：中心资源池连接数据分析、PUSH、生态营销、总编室、内容合作和质量运营六类专家" width="1800" height="1216" loading="lazy" decoding="async" /></div><figcaption><span>一个资源池，连接多类业务专家</span><a :href="asset('models')" target="_blank" rel="noopener" aria-label="模型资源池，在新标签页查看大图">查看大图<PhArrowUpRight :size="15" /></a></figcaption></figure>
      </article>

      <article id="collaboration" class="story-chapter chapter-collaboration" aria-labelledby="collaboration-title">
        <header class="chapter-heading chapter-reveal"><div><p class="story-eyebrow"><span>04</span> 办公协同</p><h2 id="collaboration-title">打通 WeLink。<br /><span>把协同，带进对话。</span></h2></div><p class="chapter-description">日程、邮件、消息、会议，汇集到同一个工作空间。从看清今天的重点，到发起下一步协同，让工作更连贯。</p></header>
        <figure class="chapter-figure chapter-reveal"><div class="chapter-screen"><img :src="asset('collaboration')" :srcset="`${asset('collaboration', 900)} 900w, ${asset('collaboration')} 1800w`" sizes="(max-width: 1440px) 90vw, 1280px" alt="宣传片中的办公协同界面：工作助手汇总今日重点、待办、日程和邮件" width="1800" height="1060" loading="lazy" decoding="async" /></div><figcaption><span>看清重点，再推进下一步</span><a :href="asset('collaboration')" target="_blank" rel="noopener" aria-label="办公协同，在新标签页查看大图">查看大图<PhArrowUpRight :size="15" /></a></figcaption></figure>
        <div class="chapter-footnotes chapter-reveal"><p><strong>看清重点</strong><span>汇集日程与邮件，梳理今日优先事项。</span></p><p><strong>推进协同</strong><span>围绕联系人、消息和会议继续工作。</span></p><p><strong>沉淀成果</strong><span>从信息整理，到文档与演示内容。</span></p></div>
        <p class="chapter-source-note">以上画面为产品宣传片中的功能演示。</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
:global(html:has(.home-chapters)){scroll-padding-top:0}
.home-chapters{background:#080f17;color:#f0f1ef;scroll-margin-top:0}
.chapter-shell{width:min(1280px,90vw);margin-inline:auto}
.chapters-intro{padding-block:132px 100px;text-align:center}
.story-eyebrow{display:flex;align-items:center;gap:20px;font-size:12px;letter-spacing:.16em;line-height:1.8;color:#a6b2c1;margin:0 0 24px}
.story-eyebrow>span{font-variant-numeric:tabular-nums;color:#8194a6;letter-spacing:.05em}
.chapters-intro .story-eyebrow{justify-content:center;margin-bottom:28px}
.chapters-intro h2{font-size:clamp(36px,4.2vw,60px);font-weight:500;letter-spacing:-.045em;line-height:1.3;margin:0}
.chapters-intro h2>span,.story-chapter h2>span{color:#a7b4c4}
.story-lead{font-size:17px;line-height:1.9;color:#a6b2c1;margin:30px 0 0}
.chapter-nav{position:sticky;top:0;z-index:5;background:#080f17f5;backdrop-filter:blur(16px);border-block:1px solid #aabacc24}
.chapter-nav>.chapter-shell{display:grid;grid-template-columns:repeat(4,1fr)}
.chapter-nav a{display:flex;align-items:center;gap:16px;min-height:76px;font-size:14px;line-height:1.5;color:#9caaba;text-decoration:none;position:relative;transition:color .2s}
.chapter-nav a>span:first-child{color:#708294;font-size:11px;font-variant-numeric:tabular-nums}
.chapter-nav a::after{content:'';position:absolute;inset:auto 36px -1px 0;height:2px;background:#d2e4ed;transform:scaleX(0);transform-origin:left;transition:transform .3s}
.chapter-nav a:hover,.chapter-nav a[aria-current]{color:#f0f1ef}.chapter-nav a[aria-current]::after{transform:scaleX(1)}
.story-chapter{padding-block:100px;scroll-margin-top:76px;border-bottom:1px solid #aabacc24}
.story-chapter h2{font-size:clamp(30px,3.1vw,44px);line-height:1.4;letter-spacing:-.035em;font-weight:500;margin:0}
.chapter-heading{display:grid;grid-template-columns:1.4fr 1fr;gap:10%;align-items:end;margin-bottom:46px}
.chapter-description{font-size:16px;line-height:1.95;color:#a6b2c1;margin:0}
.chapter-view-switch{display:flex;gap:8px;margin-bottom:22px;flex-wrap:wrap}
.chapter-view-switch button{font:inherit;font-size:13px;line-height:1.5;color:#a6b2c1;background:transparent;border:1px solid #8295a633;border-radius:24px;padding:10px 20px;cursor:pointer;transition:color .2s,background .2s,border-color .2s}
.chapter-view-switch button[aria-pressed=true]{color:#101923;background:#e3eaf0;border-color:#e3eaf0}
.chapter-view-switch button:hover:not([aria-pressed=true]){color:#fff;border-color:#8295a688}
.chapter-figure{margin:0;min-width:0}
.chapter-screen{overflow:hidden;border:1px solid #bdd1e338;border-radius:12px;background:#111d2b;box-shadow:0 22px 65px #0004}
.chapter-screen img{display:block;width:100%;height:auto}
.production-screen{aspect-ratio:1.7;background:#eaf0f8}
.production-screen img{height:100%;object-fit:contain}
.chapter-figure figcaption{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-top:18px;color:#8e9eaf;font-size:12px;line-height:1.7}
.chapter-figure figcaption a{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;color:#b7c5d2;text-decoration:none;min-height:24px}
.chapter-figure figcaption a:hover{color:#fff}
.chapter-footnotes{display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:44px}
.chapter-footnotes p{margin:0;display:flex;flex-direction:column;gap:12px}
.chapter-footnotes strong{font-size:16px;font-weight:500;color:#dce3e9}.chapter-footnotes span{font-size:14px;line-height:1.8;color:#93a3b4}
.chapter-split{display:grid;grid-template-columns:.85fr 1.65fr;align-items:center;gap:7%;padding-block:130px}
.chapter-copy .chapter-description{margin-top:26px}
.chapter-details{margin:30px 0 0}.chapter-details>div+div{margin-top:24px}
.chapter-details dt{font-size:14px;color:#dce3e9;margin-bottom:6px}.chapter-details dd{font-size:13px;line-height:1.8;margin:0;color:#93a3b4}
.chapter-reverse{grid-template-columns:1.65fr .85fr}.chapter-reverse .chapter-copy{order:2}
.chapter-link{display:inline-flex;align-items:center;gap:12px;font-size:14px;text-decoration:none;color:#dce3e9;margin-top:30px;padding-bottom:8px;border-bottom:1px solid #b1c9db55}.chapter-link:hover{color:white;border-color:white}
.chapter-source-note{font-size:11px;color:#8e9eaf;text-align:center;margin:50px 0 0}
.chapter-collaboration{border-bottom:0;padding-bottom:100px}
.home-chapters a:focus-visible,.home-chapters button:focus-visible{outline:2px solid #dceaf7;outline-offset:5px}
@media(max-width:1050px){.chapter-heading{gap:6%;grid-template-columns:1.25fr 1fr}.chapter-split{gap:5%;grid-template-columns:1fr 1.4fr}.chapter-reverse{grid-template-columns:1.4fr 1fr}.story-chapter h2{font-size:32px}.chapter-details>div+div{margin-top:18px}}
@media(max-width:900px){.chapter-split,.chapter-reverse{grid-template-columns:1fr;gap:38px;padding-block:80px}.chapter-reverse .chapter-copy{order:0}.chapter-copy{max-width:680px}.chapter-details{display:grid;grid-template-columns:repeat(2,1fr);gap:22px}.chapter-details>div+div{margin-top:0}.chapter-heading{grid-template-columns:1fr;gap:26px}.chapter-description{max-width:650px}.chapter-footnotes{gap:24px}.chapter-nav a{gap:10px;font-size:12px}.chapter-nav a::after{right:20px}}
@media(max-width:700px){.chapters-intro{padding-block:84px 64px}.chapters-intro h2{font-size:36px}.story-lead{font-size:14px;margin-top:22px}.story-eyebrow{font-size:10px;margin-bottom:18px;gap:12px}.desktop-break{display:none}.chapter-nav a{min-height:66px;flex-direction:column;align-items:flex-start;justify-content:center;gap:4px;font-size:10px;white-space:nowrap}.chapter-nav a>span:first-child{font-size:10px}.chapter-nav a::after{right:12px}.story-chapter{padding-block:64px;scroll-margin-top:66px}.story-chapter h2{font-size:29px;line-height:1.45}.chapter-heading{gap:22px;margin-bottom:30px}.chapter-description{font-size:14px;line-height:1.9}.chapter-view-switch button{font-size:11px;padding:9px 15px}.chapter-screen{border-radius:7px;box-shadow:0 12px 32px #0003}.chapter-figure figcaption{font-size:10px;gap:12px;margin-top:14px}.chapter-footnotes{grid-template-columns:1fr;gap:22px;margin-top:30px}.chapter-footnotes p{gap:6px}.chapter-footnotes strong{font-size:14px}.chapter-footnotes span{font-size:13px}.chapter-details{grid-template-columns:1fr;gap:20px;margin-top:26px}.chapter-copy .chapter-description{margin-top:22px}.chapter-link{font-size:13px}.chapter-source-note{margin-top:38px;font-size:10px}}
@media(prefers-reduced-motion:reduce){.home-chapters *{transition:none!important;scroll-behavior:auto!important}}
</style>
