<script setup lang="ts">
import { PhArrowRight, PhArrowDown, PhShieldCheck, PhBrowser, PhListChecks, PhBroadcast, PhChartBar, PhBell, PhMegaphone, PhFilmSlate, PhStar, PhLink } from '@phosphor-icons/vue'
defineProps<{ step: number }>()
const experts = [
  { name: '数据分析', icon: PhChartBar }, { name: 'PUSH', icon: PhBell },
  { name: '生态营销', icon: PhMegaphone }, { name: '总编室', icon: PhShieldCheck },
  { name: '内容合作', icon: PhFilmSlate }, { name: '质量运营', icon: PhStar },
]
</script>

<template>
  <div class="production-scene" :data-step="step" role="img" :aria-label="['合规指令平台接收国家网信办指令', '工作助手中的总编室专家接收平台下发的任务', '总编室专家在浏览器业务管理台完成指令执行与风险提示'][step]">
    <div class="system-route"><span>指令接入</span><PhArrowRight :size="14"/><span>专家执行</span><PhArrowRight :size="14"/><span>业务落地</span></div>
    <div class="system-composition">
      <div class="source-column">
        <div class="authority"><PhBroadcast :size="16"/><span>国家网信办</span><small>指令来源</small></div>
        <PhArrowDown class="source-arrow" :size="20" weight="light"/>
        <div class="system-panel source-panel">
          <div class="panel-icon"><PhListChecks :size="25" weight="light"/></div>
          <p class="system-name">总编室合规<br/>指令平台</p>
          <div class="instruction"><span>内容合规指令</span><strong>接收 · 下发</strong></div>
          <span class="panel-caption">业务任务，从这里进入</span>
        </div>
      </div>
      <div class="flow-bridge bridge-one"><PhArrowRight :size="23" weight="light"/></div>
      <div class="system-panel expert-panel">
        <div class="expert-panel-header"><img src="/brand.svg" width="29" height="29" alt=""/><span>工作助手</span></div>
        <div class="expert-symbol"><PhShieldCheck :size="52" weight="light"/></div>
        <h3>总编室专家</h3><p class="expert-role">内容合规数字人</p>
        <div class="expert-task"><span>来自合规指令平台</span><strong>接收任务，准备执行</strong><div><PhLink :size="13"/><span>已连接生产系统</span></div></div>
        <span class="expert-caption">指令下发 · 执行 · 风险提示</span>
      </div>
      <div class="flow-bridge bridge-two"><PhArrowRight :size="23" weight="light"/></div>
      <div class="system-panel execution-panel">
        <div class="execution-heading"><PhBrowser :size="24" weight="light"/><span>浏览器<br/>业务管理台</span></div>
        <div class="execution-actions"><p><span>01</span>文章撤热榜</p><p><span>02</span>文章下线</p><p class="key-action"><span>03</span><strong>网址屏蔽</strong></p></div>
        <div class="execution-note"><PhShieldCheck :size="15"/><span>执行与风险提示</span></div>
      </div>
    </div>
    <div class="expert-family"><span class="family-label">终端云场景化专家</span><div><span v-for="expert in experts" :key="expert.name" :class="{selected:expert.name==='总编室'}"><component :is="expert.icon" :size="15" weight="light"/>{{ expert.name }}</span></div></div>
    <div class="more-systems"><span>更多生产连接</span><strong>DataAgent</strong><strong>DataOps</strong></div>
  </div>
</template>

<style scoped>
.production-scene{container-type:inline-size;position:relative;width:100%;height:540px;color:#dfe6f0;--accent:#bcb0ee}
.system-route{display:flex;align-items:center;justify-content:center;gap:24px;font-size:11px;letter-spacing:.12em;color:#788497;padding:32px 0 14px}
.system-route>svg{color:#485366}.system-route>span{transition:color .65s}.production-scene[data-step="0"] .system-route>span:first-child,.production-scene[data-step="1"] .system-route>span:nth-of-type(2),.production-scene[data-step="2"] .system-route>span:last-child{color:#ded3ff}
.system-composition{height:354px;display:grid;grid-template-columns:1.02fr 30px 1.25fr 30px 1fr;align-items:center;padding:0 14px;perspective:1200px;position:relative}
.system-panel{border:1px solid #b2a2e42a;background:linear-gradient(145deg,#1c2230eb,#0d1520f5);box-shadow:0 20px 45px #0004,inset 0 1px #ffffff08;border-radius:13px;transition:opacity .8s,transform .85s cubic-bezier(.18,.68,.2,1),border-color .8s,box-shadow .8s}
.source-column{transition:opacity .8s,transform .85s;transform:translateY(-10px)}
.authority{display:flex;gap:7px;align-items:center;font-size:11px;color:#a79cbe;flex-wrap:wrap;justify-content:center}.authority small{font-size:9px;color:#6d7689}.source-arrow{display:block;margin:9px auto;color:#79708e}
.source-panel{padding:22px 19px 19px;transform:rotateY(7deg);border-color:#b9a7f04d}
.panel-icon{color:#c4b7ea;margin-bottom:16px}.system-name{font-size:18px;line-height:1.5;letter-spacing:-.02em;margin:0 0 21px;font-weight:500}
.instruction{border-top:1px solid #929db323;padding-top:15px;display:flex;flex-direction:column;gap:9px}.instruction>span{font-size:10px;color:#798498}.instruction strong{font-weight:400;font-size:12px;color:#c5b8e9}.panel-caption{display:block;font-size:9px;line-height:1.6;color:#788296;margin-top:16px}
.flow-bridge{color:#a294c9;display:grid;place-items:center;transition:opacity .7s,transform .7s;opacity:.25}.bridge-one{transform:translateX(-6px)}.bridge-two{transform:translateX(-6px)}
.expert-panel{padding:18px 20px 20px;position:relative;z-index:2;opacity:.38;transform:translateY(32px) scale(.95)}
.expert-panel-header{display:flex;align-items:center;gap:8px;font-size:11px;color:#a4afbe}.expert-panel-header img{width:25px;height:25px}.expert-symbol{margin:22px 0 12px;color:#c6b9ee;filter:drop-shadow(0 3px 16px #a68bd333)}
.expert-panel h3{font-size:22px;font-weight:500;margin:0 0 6px;letter-spacing:-.02em}.expert-role{font-size:10px;color:#9c94ae;margin:0 0 21px}.expert-task{padding:14px 12px;border:1px solid #bdabdd21;background:#998ab407;border-radius:7px;display:flex;flex-direction:column;gap:8px}.expert-task>span{color:#778294;font-size:9px}.expert-task>strong{font-size:12px;font-weight:400}.expert-task>div{display:flex;align-items:center;gap:6px;color:#a79ebc;font-size:9px}.expert-caption{display:block;color:#7c879a;font-size:9px;margin-top:14px;white-space:nowrap}
.execution-panel{padding:23px 16px 20px;opacity:.18;transform:translateX(-15px) translateY(24px) rotateY(-8deg) scale(.94)}
.execution-heading{display:flex;align-items:center;gap:10px;font-size:15px;line-height:1.6}.execution-heading svg{color:#b6a8d4;flex-shrink:0}.execution-actions{margin-top:23px}.execution-actions p{font-size:11px;display:flex;align-items:center;gap:11px;margin:0;padding:12px 0;border-bottom:1px solid #919daf17;transition:transform .7s,opacity .7s}.execution-actions p>span{font-size:9px;color:#59667c}.execution-actions strong{font-weight:600}.execution-actions .key-action{color:#d4c3fa;border-color:#b8a0e846}.execution-note{display:flex;align-items:center;gap:6px;color:#9387a9;font-size:9px;margin-top:22px}
.expert-family{margin:24px 14px 0;padding-top:18px;border-top:1px solid #b9c6dc13}.family-label{display:block;color:#707f93;font-size:9px;letter-spacing:.08em;margin-bottom:13px}.expert-family>div{display:flex;justify-content:space-between;gap:7px}.expert-family>div>span{font-size:10px;color:#788397;display:flex;align-items:center;gap:5px;white-space:nowrap}.expert-family .selected{color:#c6b5ec}.more-systems{display:flex;align-items:center;justify-content:center;gap:19px;font-size:9px;color:#5e6e81;margin-top:18px}.more-systems strong{font-size:10px;font-weight:400;color:#8b96a8}
.production-scene[data-step="1"] .expert-panel,.production-scene[data-step="2"] .expert-panel{opacity:1;transform:translateY(0) scale(1);border-color:#baa3ee6b;box-shadow:0 28px 64px #0006,0 0 44px #9b7cdb0c,inset 0 1px #e1cfff17}
.production-scene[data-step="1"] .bridge-one,.production-scene[data-step="2"] .flow-bridge{opacity:1;transform:translateX(0)}
.production-scene[data-step="2"] .execution-panel{opacity:1;transform:translateX(0) translateY(0) rotateY(-4deg) scale(1);border-color:#c8b4ee50}
.production-scene:not([data-step="2"]) .execution-actions p{transform:translateY(8px);opacity:.5}.execution-actions p:nth-child(2){transition-delay:.1s}.execution-actions p:nth-child(3){transition-delay:.2s}
@container(max-width:620px){.system-composition{padding:0 4px;grid-template-columns:1fr 22px 1.2fr 22px 1fr}.source-panel{padding:17px 12px}.system-name{font-size:16px}.expert-panel{padding:16px 14px}.expert-panel h3{font-size:20px}.execution-panel{padding:20px 12px}.execution-heading{font-size:13px;gap:6px}.expert-family>div{flex-wrap:wrap;justify-content:center;gap:13px 18px}.family-label{text-align:center}}
@container(max-width:450px){.system-route{gap:15px;padding-top:24px;font-size:10px}.system-composition{display:block;height:345px;padding:20px 12px 0;perspective:none}.system-panel{transform:none!important;width:100%;box-sizing:border-box}.source-column{position:absolute;inset:16px 25px auto;transform:none;opacity:0;pointer-events:none}.source-panel{max-width:280px;margin:auto;padding:19px 25px}.source-panel .panel-icon{float:right;margin:0}.system-name{font-size:22px;margin-bottom:18px}.authority{font-size:12px}.authority small{font-size:10px}.source-arrow{margin:6px auto}.instruction{flex-direction:row;justify-content:space-between;align-items:center}.instruction>span,.instruction strong{font-size:12px}.panel-caption{font-size:11px;margin-top:16px}.expert-panel{position:absolute;inset:26px 30px auto;width:auto;padding:18px 24px;opacity:0!important;pointer-events:none}.expert-symbol{float:right;margin:10px 0 0}.expert-panel h3{font-size:24px;margin-top:24px}.expert-panel .expert-role{font-size:12px;margin-bottom:17px}.expert-task>span,.expert-task>div,.expert-caption{font-size:10px}.expert-task>strong{font-size:13px}.execution-panel{position:absolute;inset:20px 30px auto;width:auto;padding:25px;opacity:0!important;pointer-events:none}.execution-heading{font-size:20px}.execution-heading br{display:none}.execution-actions{margin-top:16px}.execution-actions p{font-size:14px;padding:15px 0}.execution-note{font-size:11px}.flow-bridge{display:none}.production-scene[data-step="0"] .source-column,.production-scene[data-step="1"] .expert-panel,.production-scene[data-step="2"] .execution-panel{opacity:1!important;pointer-events:auto}.production-scene[data-step="2"] .expert-panel{opacity:0!important}.expert-family{margin-top:5px}.expert-family>div>span{font-size:11px}.more-systems{margin-top:17px}}
@media(prefers-reduced-motion:reduce){.production-scene *{transition:none!important;transform:none!important}}
</style>
