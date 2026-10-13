<script setup lang="ts">
import { computed } from 'vue'
import { PhTarget, PhChatsCircle, PhMicrophoneStage, PhSparkle, PhUsersThree, PhStack, PhArrowDown } from '@phosphor-icons/vue'

const props = defineProps<{ step: number }>()
const phase = computed(() => Math.min(2, Math.max(0, Math.round(props.step))))
const descriptions = [
  '技能市场场景演示，第一步：Skill Hunt 精选热点选题雷达、社群运营话术与直播脚本助手，发现适合业务场景的技能。',
  '技能市场场景演示，第二步：查看热点选题雷达的用途。围绕产品与行业动态，整理热点摘要和选题切入角度，获取后在工作助手中使用。',
  '技能市场场景演示，第三步：配合专家按工号分发和 Onebox 知识同步，让团队共享专家与知识。技能获取、专家分发和知识同步是各自独立的能力。',
]
</script>

<template>
  <div class="skill-flow-scene" :data-step="phase" role="img" :aria-label="descriptions[phase]">
    <div class="skill-stage" aria-hidden="true">
      <div class="skill-ground-light"></div>
      <div class="skill-catalog skill-surface">
        <div class="skill-window-label"><PhStack :size="15" /><span>技能市场</span><span class="skill-window-meta">发现 · 获取</span></div>
        <div class="skill-catalog-heading"><span class="skill-overline">精选技能</span><h3>Skill Hunt</h3><p>全网优质 Skill 洞察精选</p></div>
        <div class="skill-list">
          <div class="skill-row skill-featured-row"><span class="skill-icon"><PhTarget :size="23" /></span><div><strong>热点选题雷达</strong><p>捕捉热点，找到内容切入点</p></div><span class="skill-row-kind">内容运营</span></div>
          <div class="skill-row"><span class="skill-icon"><PhChatsCircle :size="23" /></span><div><strong>社群运营话术</strong><p>让每次社群沟通更有准备</p></div><span class="skill-row-kind">用户运营</span></div>
          <div class="skill-row"><span class="skill-icon"><PhMicrophoneStage :size="23" /></span><div><strong>直播脚本助手</strong><p>从活动信息到直播流程</p></div><span class="skill-row-kind">直播运营</span></div>
        </div>
      </div>

      <div class="skill-detail skill-surface">
        <div class="skill-detail-heading"><span class="skill-icon skill-detail-icon"><PhTarget :size="27" /></span><div><span class="skill-overline">技能用途</span><h3>热点选题雷达</h3></div></div>
        <p class="skill-detail-intro">给选题，一个更清楚的起点。</p>
        <dl class="skill-purpose"><div><dt>关注方向</dt><dd>产品与行业动态</dd></div><div><dt>输出内容</dt><dd>热点摘要 · 选题切入角度</dd></div></dl>
        <div class="skill-acquire"><PhArrowDown :size="17" /><span>获取后，在工作助手中使用</span></div>
      </div>

      <div class="skill-sharing skill-surface">
        <div class="skill-sharing-heading"><PhSparkle :size="19" /><span>让团队接着用</span><small>专家与知识</small></div>
        <div class="skill-sharing-row"><PhUsersThree :size="26" /><div><strong>专家按工号分发</strong><p>选择接收人，分享专属专家</p></div></div>
        <div class="skill-sharing-row"><PhStack :size="25" /><div><strong>Onebox 知识同步</strong><p>把分享的知识带入工作空间</p></div></div>
        <p class="skill-sharing-note">好方法，被团队继续使用。</p>
      </div>
      <div class="skill-stage-caption"><span>{{ ['发现所需技能', '看清用途，再获取', '专家与知识，协同分发'][phase] }}</span><small>场景演示</small></div>
    </div>
  </div>
</template>

<style scoped>
.skill-flow-scene{container:skill-flow / inline-size;position:relative;width:100%;height:540px;isolation:isolate;overflow:hidden;color:#e6edf4;background:transparent;font-family:inherit}
.skill-stage{position:relative;height:100%;perspective:1400px;overflow:hidden}
.skill-stage *{box-sizing:border-box}.skill-stage h3,.skill-stage p{margin:0}.skill-stage svg{flex-shrink:0}
.skill-ground-light{position:absolute;inset:20% 2% 4%;background:radial-gradient(ellipse at 50% 64%,#80d4c612,transparent 68%);pointer-events:none}
.skill-surface{position:absolute;overflow:hidden;border:1px solid #b6d2e025;border-radius:12px;background:linear-gradient(135deg,#152130f5,#101a25fc 70%);box-shadow:0 14px 32px #0004,inset 0 1px #e1eef40d,inset 0 -1px #0004;transition:transform 780ms cubic-bezier(.22,.61,.36,1),opacity 700ms ease,border-color 700ms ease;will-change:transform,opacity}
.skill-catalog{left:8%;top:48px;width:82%;padding:0 25px 18px;transform:rotateX(2deg) rotateY(-2deg)}
.skill-window-label{display:flex;align-items:center;gap:8px;height:45px;color:#8493a5;font-size:11px;border-bottom:1px solid #b6d2e018}
.skill-window-meta{margin-left:auto;font-size:10px;letter-spacing:.05em}
.skill-catalog-heading{padding:22px 0 18px}.skill-overline{display:block;color:#80d4c6;font-size:10px;letter-spacing:.13em;line-height:1.6}
.skill-catalog-heading h3{font-size:26px;font-weight:500;letter-spacing:-.035em;line-height:1.25;margin-top:5px}.skill-catalog-heading p{font-size:12px;color:#8493a5;margin-top:7px}
.skill-list{border-top:1px solid #b6d2e018}.skill-row{display:flex;gap:14px;align-items:center;min-height:72px;border-bottom:1px solid #b6d2e018}.skill-row:last-child{border-bottom:0}
.skill-icon{display:flex;align-items:center;justify-content:center;flex:none;width:41px;height:41px;color:#94acbb;background:#a9c4d508;border:1px solid #bdd7e519;border-radius:10px}
.skill-featured-row .skill-icon{color:#80d4c6;border-color:#80d4c633;background:#80d4c60a}.skill-row strong{font-weight:500;font-size:14px;line-height:1.5}.skill-row p{font-size:11px;color:#8493a5;line-height:1.7;margin-top:3px}.skill-row-kind{margin-left:auto;font-size:10px;color:#758799;white-space:nowrap}
.skill-detail{left:24%;top:116px;width:68%;padding:26px;opacity:0;transform:translate3d(24px,48px,0) scale(.96) rotateX(2deg)}
.skill-detail-heading{display:flex;gap:14px;align-items:center}.skill-detail-icon{width:48px;height:48px;color:#80d4c6;border-color:#80d4c63a}.skill-detail h3{font-weight:500;font-size:21px;line-height:1.5;margin-top:3px}.skill-detail-intro{font-size:13px;line-height:1.8;color:#a5b5c3;padding-top:23px}
.skill-purpose{margin:21px 0 0;border-top:1px solid #b6d2e020}.skill-purpose>div{display:flex;gap:20px;padding:13px 0;border-bottom:1px solid #b6d2e020;font-size:12px;line-height:1.7}.skill-purpose dt{color:#8493a5;white-space:nowrap}.skill-purpose dd{margin:0;color:#d3dee8}
.skill-acquire{display:flex;align-items:center;gap:9px;font-size:12px;color:#80d4c6;margin-top:21px;line-height:1.7}
.skill-sharing{top:180px;left:15%;width:77%;padding:24px 26px 20px;opacity:0;transform:translate3d(12px,55px,0) scale(.96) rotateX(2deg)}
.skill-sharing-heading{display:flex;align-items:center;gap:9px;font-size:17px;font-weight:500;margin-bottom:20px}.skill-sharing-heading>svg{color:#80d4c6}.skill-sharing-heading small{font-size:10px;font-weight:400;color:#8493a5;margin-left:auto}
.skill-sharing-row{display:flex;gap:18px;align-items:center;padding:16px 0;border-top:1px solid #b6d2e020}.skill-sharing-row>svg{color:#80d4c6}.skill-sharing-row strong{font-weight:500;font-size:14px;line-height:1.5}.skill-sharing-row p{font-size:11px;line-height:1.7;color:#8493a5;margin-top:4px}.skill-sharing-note{border-top:1px solid #b6d2e020;padding-top:14px;font-size:11px;color:#9bafbe;line-height:1.6}
.skill-stage-caption{position:absolute;bottom:17px;left:8%;right:8%;display:flex;justify-content:space-between;gap:12px;font-size:11px;line-height:1.6;color:#8493a5}.skill-stage-caption small{font-size:10px;color:#65788a;white-space:nowrap}
.skill-flow-scene[data-step="1"] .skill-catalog{transform:translate3d(-21px,-20px,-30px) rotateX(2deg) rotateY(-3deg) scale(.95);opacity:.32}.skill-flow-scene[data-step="1"] .skill-detail{opacity:1;transform:translate3d(0,0,0) rotateX(2deg);border-color:#80d4c63b}
.skill-flow-scene[data-step="2"] .skill-catalog{transform:translate3d(-9px,-31px,-50px) rotateX(2deg) scale(.94);opacity:.26}.skill-flow-scene[data-step="2"] .skill-detail{opacity:.2;transform:translate3d(-22px,-40px,-30px) scale(.97) rotateX(2deg)}.skill-flow-scene[data-step="2"] .skill-sharing{opacity:1;transform:translate3d(0,0,0) rotateX(2deg);border-color:#80d4c638}
@container skill-flow (max-width:520px){
  .skill-stage{perspective:none}.skill-catalog{top:34px;left:5%;width:90%;padding:0 18px 12px;transform:none}.skill-window-label{height:39px}.skill-window-meta{display:none}.skill-catalog-heading{padding:19px 0 16px}.skill-catalog-heading h3{font-size:25px}.skill-catalog-heading p{font-size:11px}.skill-row{min-height:73px;gap:11px}.skill-row-kind{display:none}.skill-row strong{font-size:14px}.skill-row p{font-size:11px}.skill-icon{width:37px;height:37px}
  .skill-detail{left:8%;top:102px;width:87%;padding:23px 20px;transform:translateY(36px)}.skill-detail h3{font-size:20px}.skill-detail-icon{width:42px;height:42px}.skill-purpose>div{gap:14px;font-size:11px}.skill-detail-intro{font-size:12px;padding-top:22px}.skill-acquire{font-size:11px}.skill-sharing{top:158px;left:8%;width:87%;padding:22px 20px 18px;transform:translateY(38px)}.skill-sharing-heading{font-size:16px;gap:7px;margin-bottom:15px}.skill-sharing-heading small{display:none}.skill-sharing-row{gap:14px;padding:15px 0}.skill-sharing-row strong{font-size:14px}.skill-sharing-note{font-size:11px}
  .skill-flow-scene[data-step="1"] .skill-catalog{transform:translateY(-12px);opacity:.28}.skill-flow-scene[data-step="1"] .skill-detail{transform:none}.skill-flow-scene[data-step="2"] .skill-catalog{transform:translateY(-20px)}.skill-flow-scene[data-step="2"] .skill-detail{transform:translate(-8px,-38px)}.skill-flow-scene[data-step="2"] .skill-sharing{transform:none}.skill-stage-caption{left:6%;right:6%;bottom:16px;font-size:10px}
}
@media(max-width:600px){.skill-flow-scene{height:500px}}
@media(prefers-reduced-motion:reduce){.skill-surface{transition:none;will-change:auto}}
</style>
