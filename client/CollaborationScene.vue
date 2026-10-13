<script setup lang="ts">
import { computed } from 'vue'
import { PhCalendarBlank, PhEnvelopeSimple, PhListChecks, PhChatsCircle, PhCheckCircle, PhUsersThree, PhPaperPlaneTilt } from '@phosphor-icons/vue'

const props = defineProps<{ step: number }>()
const phase = computed(() => Math.min(2, Math.max(0, Math.round(props.step))))
const descriptions = [
  '办公协同场景演示，第一步：WeLink 日程与邮件输入。日程中有十四点的 PUSH 策略例会，邮件提醒十七点前提交国庆追剧季材料。',
  '办公协同场景演示，第二步：工作助手将日程与邮件汇集为今日重点：十七点前提交国庆追剧季材料、十八点前审核召回 PUSH、十四点 PUSH 策略例会。',
  '办公协同场景演示，第三步：重现宣传片任务：约张三、李四明天上午十点开十月版本需求评审会，并在 WeLink 上通知他们。演示结果为查找联系人、创建会议日程、WeLink 消息通知两人已送达。此场景为宣传片任务演示，不执行真实操作。',
]
</script>

<template>
  <div class="collaboration-scene" :data-step="phase" role="img" :aria-label="descriptions[phase]">
    <div class="collab-stage" aria-hidden="true">
      <div class="collab-ground-light"></div>
      <div class="collab-input collab-surface">
        <div class="collab-window-label"><PhCalendarBlank :size="15" /><span>协同工作空间</span><span class="collab-source">WeLink</span></div>
        <div class="collab-input-heading"><span class="collab-overline">工作从这里开始</span><h3>日程与邮件，都在眼前。</h3></div>
        <div class="collab-source-row"><span class="collab-input-icon"><PhCalendarBlank :size="25" /></span><div><span class="collab-input-kind">今日日程</span><strong>14:00 PUSH 策略例会</strong><p>对齐节后召回人群、文案与投放节奏</p></div></div>
        <div class="collab-source-row"><span class="collab-input-icon"><PhEnvelopeSimple :size="25" /></span><div><span class="collab-input-kind">最近邮件</span><strong>17:00 前提交国庆追剧季材料</strong><p>请补齐 DAU、新增与 PUSH 效果数据</p></div></div>
        <div class="collab-input-footer"><span>日程</span><span>邮件</span><span>同一份工作上下文</span></div>
      </div>

      <div class="collab-focus collab-surface">
        <div class="collab-focus-heading"><PhListChecks :size="26" /><div><span class="collab-overline">从信息中梳理</span><h3>今日重点</h3></div><span class="collab-focus-sources">日程 + 邮件</span></div>
        <p class="collab-focus-intro">今天，优先处理这几件事。</p>
        <div class="collab-priority"><span>01</span><div><strong>17:00 前提交国庆追剧季材料</strong><p>补齐 DAU、新增与 PUSH 效果</p></div></div>
        <div class="collab-priority"><span>02</span><div><strong>18:00 前审核召回 PUSH</strong><p>确认节后召回文案与投放方案</p></div></div>
        <div class="collab-priority"><span>03</span><div><strong>14:00 PUSH 策略例会</strong><p>会前准备 A/B 标题方案</p></div></div>
        <div class="collab-context-note"><PhEnvelopeSimple :size="15" /><span>保留日程与邮件上下文</span></div>
      </div>

      <div class="collab-draft collab-surface">
        <div class="collab-draft-top"><PhChatsCircle :size="19" /><span>协同执行</span><strong>已完成</strong></div>
        <h3>安排会议 · 通知参会人</h3>
        <p class="collab-request">约张三、李四明天上午 10 点开 10 月版本需求评审会，并在 WeLink 上通知他们。</p>
        <div class="collab-draft-details"><div><PhUsersThree :size="18" /><span>查找联系人</span><strong>张三、李四</strong></div><div><PhCalendarBlank :size="18" /><span>创建会议</span><strong>明天 10:00</strong></div><div><PhPaperPlaneTilt :size="18" /><span>WeLink 通知</span><strong>2 人已送达</strong></div></div>
        <div class="collab-confirmation"><PhCheckCircle :size="18" /><p>会议已创建，通知已送达。</p></div>
      </div>
      <div class="collab-stage-caption"><span>{{ ['从日程与邮件开始', '把信息，汇成今日重点', '从一句话，到完成协同'][phase] }}</span><small>宣传片任务演示</small></div>
    </div>
  </div>
</template>

<style scoped>
.collaboration-scene{container:collaboration / inline-size;position:relative;width:100%;height:540px;isolation:isolate;overflow:hidden;color:#e6edf4;background:transparent;font-family:inherit}
.collab-stage{position:relative;height:100%;perspective:1400px;overflow:hidden}.collab-stage *{box-sizing:border-box}.collab-stage h3,.collab-stage p{margin:0}.collab-stage svg{flex-shrink:0}
.collab-ground-light{position:absolute;inset:15% 0 3%;background:radial-gradient(ellipse at 55% 65%,#d8c6a90e,transparent 69%);pointer-events:none}
.collab-surface{position:absolute;border:1px solid #c7d3df25;border-radius:12px;background:linear-gradient(135deg,#152130f5,#101a25fc 72%);box-shadow:0 14px 32px #0004,inset 0 1px #e1eef40d,inset 0 -1px #0004;overflow:hidden;transition:transform 800ms cubic-bezier(.22,.61,.36,1),opacity 700ms ease,border-color 700ms ease;will-change:transform,opacity}
.collab-input{left:8%;top:53px;width:82%;padding:0 25px 18px;transform:rotateX(2deg) rotateY(2deg)}
.collab-window-label{display:flex;align-items:center;gap:8px;height:45px;font-size:11px;color:#8493a5;border-bottom:1px solid #c7d3df18}.collab-source{margin-left:auto;font-size:11px;color:#b6c0cb;letter-spacing:.04em}
.collab-input-heading{padding:24px 0 19px}.collab-overline{display:block;font-size:10px;color:#d8c6a9;letter-spacing:.1em;line-height:1.6}.collab-input h3{font-size:23px;font-weight:500;letter-spacing:-.03em;line-height:1.45;margin-top:7px}
.collab-source-row{display:flex;align-items:center;gap:17px;padding:17px 0;border-top:1px solid #c7d3df18}.collab-input-icon{display:flex;justify-content:center;align-items:center;width:43px;height:48px;color:#bdc8d4;background:#b9cad508;border:1px solid #c7d3df1c;border-radius:9px;flex:none}.collab-input-kind{display:block;font-size:10px;color:#8493a5;line-height:1.6;margin-bottom:5px}.collab-source-row strong{display:block;font-size:14px;font-weight:500;line-height:1.6}.collab-source-row p{font-size:11px;line-height:1.6;color:#8493a5;margin-top:4px}
.collab-input-footer{display:flex;gap:14px;align-items:center;border-top:1px solid #c7d3df18;padding-top:16px;font-size:10px;color:#8c9cac}.collab-input-footer>span:last-child{margin-left:auto;color:#697d90}
.collab-focus{left:21%;top:112px;width:72%;padding:25px 27px;opacity:0;transform:translate3d(18px,48px,0) scale(.96) rotateX(2deg)}.collab-focus-heading{display:flex;align-items:center;gap:14px}.collab-focus-heading>svg{color:#d8c6a9}.collab-focus h3{font-size:24px;font-weight:500;line-height:1.35;margin-top:3px}.collab-focus-sources{margin-left:auto;font-size:10px;color:#8493a5;white-space:nowrap}.collab-focus-intro{font-size:13px;color:#b3c0cd;line-height:1.7;padding:20px 0 17px}
.collab-priority{display:flex;gap:17px;padding:13px 0;border-top:1px solid #c7d3df20}.collab-priority>span{font-size:11px;line-height:1.9;color:#d8c6a9;font-variant-numeric:tabular-nums}.collab-priority strong{font-size:14px;font-weight:500;line-height:1.6}.collab-priority p{font-size:11px;color:#8493a5;line-height:1.7;margin-top:4px}.collab-context-note{display:flex;gap:8px;align-items:center;border-top:1px solid #c7d3df20;padding-top:16px;color:#9baabb;font-size:11px}
.collab-draft{left:22%;top:103px;width:71%;padding:23px 27px;opacity:0;transform:translate3d(10px,55px,0) scale(.96) rotateX(2deg)}.collab-draft-top{display:flex;align-items:center;gap:8px;font-size:11px;color:#a7b6c4;margin-bottom:16px}.collab-draft-top>svg{color:#d8c6a9}.collab-draft-top strong{font-size:10px;font-weight:400;color:#d8c6a9;margin-left:auto;padding:3px 9px;border:1px solid #d8c6a930;border-radius:4px;background:#d8c6a907}
.collab-draft h3{font-size:21px;font-weight:500;line-height:1.5;letter-spacing:-.025em}.collab-request{margin-top:15px!important;padding:12px 14px;border-left:1px solid #d8c6a93b;background:#d8c6a906;color:#c6d1dc;font-size:12px;line-height:1.85}.collab-draft-details{display:grid;gap:0;margin-top:16px}.collab-draft-details>div{display:flex;gap:11px;align-items:center;font-size:11px;color:#a8b9c8;line-height:1.7;padding:10px 0;border-bottom:1px solid #c7d3df16}.collab-draft-details svg{color:#8493a5}.collab-draft-details strong{margin-left:auto;font-size:11px;font-weight:400;color:#d8c6a9;white-space:nowrap}
.collab-confirmation{display:flex;gap:9px;align-items:center;margin-top:15px;color:#d8c6a9}.collab-confirmation p{font-size:11px;line-height:1.7}
.collab-stage-caption{position:absolute;bottom:17px;left:8%;right:8%;display:flex;justify-content:space-between;gap:12px;color:#8493a5;font-size:11px;line-height:1.6}.collab-stage-caption small{font-size:10px;color:#65788a;white-space:nowrap}
.collaboration-scene[data-step="1"] .collab-input{transform:translate3d(-18px,-25px,-30px) rotateX(2deg) rotateY(2deg) scale(.95);opacity:.3}.collaboration-scene[data-step="1"] .collab-focus{opacity:1;transform:translate3d(0,0,0) rotateX(2deg);border-color:#d8c6a936}
.collaboration-scene[data-step="2"] .collab-input{transform:translate3d(-10px,-31px,-50px) rotateX(2deg) scale(.94);opacity:.18}.collaboration-scene[data-step="2"] .collab-focus{transform:translate3d(-30px,-43px,-30px) scale(.97) rotateX(2deg);opacity:.24}.collaboration-scene[data-step="2"] .collab-draft{opacity:1;transform:translate3d(0,0,0) rotateX(2deg);border-color:#d8c6a944}
@container collaboration (max-width:520px){
  .collab-stage{perspective:none}.collab-input{top:32px;left:5%;width:90%;padding:0 18px 16px;transform:none}.collab-window-label{height:39px}.collab-input-heading{padding:22px 0 17px}.collab-input h3{font-size:20px}.collab-source-row{gap:12px;padding:17px 0}.collab-input-icon{width:36px;height:43px}.collab-source-row strong{font-size:12px}.collab-source-row p{font-size:10px}.collab-input-footer{gap:11px;font-size:10px}.collab-input-footer>span:last-child{font-size:9px}
  .collab-focus{left:8%;top:88px;width:87%;padding:22px 20px;transform:translateY(36px)}.collab-focus-heading{gap:12px}.collab-focus h3{font-size:23px}.collab-focus-sources{font-size:9px}.collab-focus-intro{font-size:12px;padding:17px 0 14px}.collab-priority{gap:11px;padding:12px 0}.collab-priority strong{font-size:12px}.collab-priority p{font-size:10px}.collab-context-note{font-size:10px;padding-top:13px}
  .collab-draft{left:8%;top:95px;width:87%;padding:21px 20px;transform:translateY(40px)}.collab-draft-top{margin-bottom:15px}.collab-draft h3{font-size:18px}.collab-request{font-size:12px;line-height:1.8;padding:11px 12px}.collab-draft-details{margin-top:14px}.collab-draft-details>div{font-size:11px;gap:8px;padding:9px 0}.collab-draft-details strong{font-size:10px}.collab-confirmation{margin-top:14px}.collab-confirmation p{font-size:11px}
  .collaboration-scene[data-step="1"] .collab-input{transform:translateY(-12px);opacity:.28}.collaboration-scene[data-step="1"] .collab-focus{transform:none}.collaboration-scene[data-step="2"] .collab-input{transform:translateY(-20px)}.collaboration-scene[data-step="2"] .collab-focus{transform:translate(-8px,-36px)}.collaboration-scene[data-step="2"] .collab-draft{transform:none}.collab-stage-caption{left:6%;right:6%;bottom:16px;font-size:10px}
}
@media(max-width:600px){.collaboration-scene{height:500px}}
@media(prefers-reduced-motion:reduce){.collab-surface{transition:none;will-change:auto}}
</style>
