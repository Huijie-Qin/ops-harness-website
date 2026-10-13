<script setup lang="ts">
import { computed } from 'vue'
import { PhArrowRight, PhBookOpen, PhCheck, PhDatabase, PhIntersect, PhListChecks } from '@phosphor-icons/vue'

const props = defineProps<{ step: number }>()
const phase = computed(() => Number.isFinite(props.step) ? Math.min(2, Math.max(0, Math.round(props.step))) : 0)
const descriptions = [
  '数据分析场景演示，第一步：查询云端指标知识库，对齐 DAU、新增用户与 7 日留存的指标口径。',
  '数据分析场景演示，第二步：工作助手的数据分析专家通过 DataAgent 查询趋势、渠道与版本数据，通过 DataOps 查询活动与投放排期，进行多轮取数。',
  '数据分析场景演示，第三步：交叉分析趋势变化、渠道贡献与活动排期，形成归因线索。此处为分析流程演示，不代表实际业务结果。',
] as const
</script>

<template>
  <div class="data-flow-scene" :data-step="phase" role="img" :aria-label="descriptions[phase]">
    <div class="data-stage" aria-hidden="true">
      <div class="data-ambient"></div>

      <div class="data-surface metrics-surface">
        <div class="data-window-label"><PhBookOpen :size="16" /><span>云端指标知识库</span><span class="data-window-meta">指标口径</span></div>
        <div class="metrics-heading"><span class="data-overline">先对齐口径</span><h3>让每一次取数，有共同定义。</h3></div>
        <table class="metric-table">
          <thead><tr><th>指标</th><th>核对口径</th></tr></thead>
          <tbody>
            <tr class="metric-highlight"><th><strong>DAU</strong><small>日活跃用户</small></th><td>有效播放 · 去重用户<PhCheck :size="15" /></td></tr>
            <tr><th><strong>新增用户</strong><small>用户增长</small></th><td>时间范围 · 来源渠道</td></tr>
            <tr><th><strong>7 日留存</strong><small>用户留存</small></th><td>新增用户 · 版本对照</td></tr>
          </tbody>
        </table>
        <div class="metric-footnote"><PhBookOpen :size="14" /><span>定义、统计范围和时间粒度，先确认再分析。</span></div>
      </div>

      <div class="data-surface fetching-surface">
        <div class="data-window-label"><img src="/brand.svg" width="20" height="20" alt="" /><span>工作助手</span><span class="data-window-meta">数据分析专家</span></div>
        <div class="fetching-heading"><h3>多轮取数，把线索放在一起。</h3><p>看趋势，再按渠道与版本拆解。</p></div>
        <div class="data-providers">
          <div class="data-provider"><span class="provider-symbol"><PhDatabase :size="22" weight="light" /></span><div><strong>DataAgent</strong><span>趋势、渠道、版本</span></div><small>数据问数</small></div>
          <div class="data-provider data-ops-provider"><span class="provider-symbol"><PhListChecks :size="22" weight="light" /></span><div><strong>DataOps</strong><span>活动、投放排期</span></div><small>业务取数</small></div>
        </div>
        <div class="fetch-list">
          <div class="fetch-list-label"><span>交叉取数清单</span><span>分析维度</span></div>
          <div><span><PhCheck :size="13" />DAU 与新增趋势</span><small>日粒度</small></div>
          <div><span><PhCheck :size="13" />分渠道新增 / 分版本 7 日留存</span><small>渠道 · 版本</small></div>
          <div><span><PhCheck :size="13" />活动与投放排期</span><small>时间对照</small></div>
        </div>
      </div>

      <div class="data-surface attribution-surface">
        <div class="attribution-heading"><span class="attribution-symbol"><PhIntersect :size="27" weight="light" /></span><div><span class="data-overline">数据分析专家</span><h3>交叉归因</h3></div><span class="attribution-kind">分析线索</span></div>
        <div class="attribution-route"><strong>趋势变化</strong><PhArrowRight :size="16" /><strong>渠道贡献</strong><PhArrowRight :size="16" /><strong>活动排期</strong></div>
        <dl class="attribution-findings">
          <div><dt>趋势变化</dt><dd>对齐 DAU 与新增用户的变化时间</dd></div>
          <div><dt>渠道贡献</dt><dd>结合分渠道新增与分版本留存，拆解来源</dd></div>
          <div><dt>活动排期</dt><dd>对照活动和投放节奏，补充归因线索</dd></div>
        </dl>
        <div class="attribution-summary"><PhIntersect :size="18" /><p>多来源交叉分析，整理归因线索。</p></div>
      </div>

      <div class="data-stage-caption"><span>{{ ['口径一致，分析才有起点', 'DataAgent × DataOps · 多轮取数', '趋势、渠道、活动 · 交叉归因'][phase] }}</span><small>场景演示</small></div>
    </div>
  </div>
</template>

<style scoped>
.data-flow-scene{container:data-flow / inline-size;position:relative;width:100%;max-width:820px;margin-inline:auto;isolation:isolate;color:#e2e9f3;font-family:inherit}
.data-stage{position:relative;height:540px;overflow:hidden;perspective:1400px}
.data-stage *{box-sizing:border-box}.data-stage h3,.data-stage p{margin:0}.data-stage svg{flex-shrink:0}
.data-ambient{position:absolute;inset:14% 0 3%;background:radial-gradient(ellipse at 48% 55%,#a39be712,transparent 67%);pointer-events:none}
.data-surface{position:absolute;overflow:hidden;border:1px solid #afb8d42b;border-radius:14px;background:linear-gradient(130deg,#172232,#121c29 70%);box-shadow:0 25px 60px #0005,inset 0 1px #d3e3ff08;transition:transform 780ms cubic-bezier(.22,.61,.36,1),opacity 720ms,border-color 720ms;transform-origin:35% 15%;will-change:transform,opacity}
.data-window-label{display:flex;align-items:center;gap:9px;min-height:48px;padding:13px 22px;border-bottom:1px solid #bdd4ee10;font-size:12px;font-weight:500;letter-spacing:.02em;color:#bdc6d7}
.data-window-label>svg{color:#b6a8e6}.data-window-label>img{object-fit:contain}.data-window-meta{margin-left:auto;font-size:10px;font-weight:400;color:#77879d;white-space:nowrap}
.data-overline{display:block;font-size:10px;letter-spacing:.1em;font-weight:500;color:#b4a8db}
.metrics-surface{z-index:1;top:34px;left:7%;width:79%}
.metrics-heading{padding:26px 26px 16px}.metrics-heading h3{margin-top:9px;font-size:23px;font-weight:500;letter-spacing:-.04em;line-height:1.4}
.metric-table{width:calc(100% - 52px);margin:0 26px;border-collapse:collapse;text-align:left;font-size:12px}
.metric-table thead th{padding:10px 13px;color:#7f8da3;font-size:10px;font-weight:400;border-bottom:1px solid #dce8ff14}
.metric-table tbody th{width:40%;padding:13px;font-weight:400}.metric-table strong{display:block;font-size:14px;font-weight:500}.metric-table small{display:block;margin-top:4px;font-size:10px;color:#8190a5}.metric-table tbody td{position:relative;padding:13px 25px 13px 13px;color:#a9b7ca;font-size:12px}.metric-table tbody td svg{position:absolute;right:12px;top:25px;color:#a8d5d1}.metric-table tbody tr{border-bottom:1px solid #c6dbef0c}.metric-highlight{background:linear-gradient(90deg,#b9a2ff10,#a8dfd405)}.metric-highlight strong{color:#d1c4f4}
.metric-footnote{display:flex;gap:7px;align-items:center;margin:17px 26px 23px;color:#7f8fa4;font-size:10px;line-height:1.6}.metric-footnote svg{color:#9a8eb9}
.fetching-surface{z-index:2;top:81px;left:17%;width:76%;opacity:0;transform:translate(35px,60px) scale(.96)}
.fetching-heading{padding:20px 23px 15px}.fetching-heading h3{font-size:21px;font-weight:500;letter-spacing:-.035em;line-height:1.4}.fetching-heading p{margin-top:7px;color:#8595aa;font-size:11px}
.data-providers{margin:0 23px;border:1px solid #b2cfe418;border-radius:9px;overflow:hidden;background:#0c15217a}.data-provider{display:flex;align-items:center;gap:12px;padding:13px 15px}.data-provider+.data-provider{border-top:1px solid #bad5ef0e}.provider-symbol{display:flex;color:#c1b3ee}.data-provider>div{display:flex;align-items:baseline;gap:16px;min-width:0;flex:1}.data-provider strong{min-width:81px;font-size:14px;font-weight:500;color:#d9d0f0}.data-provider div>span{font-size:11px;color:#a8b6ca}.data-provider small{color:#728398;font-size:9px;white-space:nowrap}.data-ops-provider .provider-symbol,.data-ops-provider strong{color:#a8d4d3}
.fetch-list{margin:15px 23px 21px;font-size:11px}.fetch-list>div{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0}.fetch-list>div+div{border-top:1px solid #bacde40b}.fetch-list .fetch-list-label{padding:0 0 8px;color:#7f8da1;font-size:10px}.fetch-list>div>span{display:flex;align-items:center;gap:9px}.fetch-list svg{color:#89b5b3}.fetch-list small{font-size:9px;color:#7e8ea3;white-space:nowrap}
.attribution-surface{z-index:3;top:149px;left:14%;width:79%;opacity:0;transform:translate(25px,65px) scale(.96);background:linear-gradient(135deg,#1e2736,#121c29 75%);border-color:#bdb1df45}
.attribution-heading{display:flex;gap:13px;align-items:center;padding:25px 27px 22px}.attribution-symbol{display:flex;align-items:center;justify-content:center;width:46px;height:46px;flex-shrink:0;border-radius:12px;color:#cfc0f4;background:#b99af312;border:1px solid #c3a5f523}.attribution-heading h3{font-size:23px;line-height:1.2;font-weight:500;letter-spacing:-.03em;margin-top:7px}.attribution-kind{margin-left:auto;padding:5px 8px;border:1px solid #a6d9d228;border-radius:5px;color:#a6c6c5;font-size:9px;white-space:nowrap}
.attribution-route{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 27px;padding:15px 16px;background:#b9b0e20a;border:1px solid #b7a6df1b;border-radius:8px}.attribution-route strong{font-size:13px;font-weight:500;white-space:nowrap;color:#d8cfee}.attribution-route svg{color:#7e849e}
.attribution-findings{margin:15px 27px 0}.attribution-findings>div{display:grid;grid-template-columns:68px 1fr;gap:14px;padding:10px 0;border-bottom:1px solid #c3d7eb0d;font-size:11px;line-height:1.6}.attribution-findings dt{color:#b5c3d5}.attribution-findings dd{margin:0;color:#8999ae}
.attribution-summary{display:flex;align-items:center;gap:10px;margin:19px 27px 24px;color:#a7ccc9;font-size:12px;line-height:1.6}.attribution-summary svg{color:#9bbfbf}
.data-stage-caption{position:absolute;left:7%;right:7%;bottom:18px;display:flex;align-items:center;justify-content:space-between;gap:14px;color:#8997ad;font-size:11px;line-height:1.5}.data-stage-caption small{color:#65748b;font-size:9px;white-space:nowrap}
.data-flow-scene[data-step="1"] .metrics-surface{opacity:.4;transform:translate(-13px,-12px) scale(.95)}
.data-flow-scene[data-step="1"] .fetching-surface{opacity:1;transform:translate(0,0) scale(1);border-color:#bcb1e33d}
.data-flow-scene[data-step="2"] .metrics-surface{opacity:.23;transform:translate(-18px,-14px) scale(.92)}
.data-flow-scene[data-step="2"] .fetching-surface{opacity:.42;transform:translate(-20px,-40px) scale(.96)}
.data-flow-scene[data-step="2"] .attribution-surface{opacity:1;transform:translate(0,0) scale(1)}
@container data-flow (max-width:600px){.data-window-label{padding-inline:18px}.metrics-heading{padding-inline:20px}.metrics-heading h3{font-size:21px}.metric-table{width:calc(100% - 40px);margin-inline:20px}.metric-footnote{margin-inline:20px}.fetching-heading{padding-inline:19px}.fetching-heading h3{font-size:19px}.data-providers,.fetch-list{margin-inline:19px}.data-provider{gap:9px;padding:12px}.data-provider>div{gap:9px}.data-provider strong{min-width:73px;font-size:13px}.data-provider small{display:none}.attribution-heading{padding-inline:22px}.attribution-route,.attribution-findings,.attribution-summary{margin-inline:22px}.attribution-findings>div{gap:9px}.attribution-route strong{font-size:12px}}
@container data-flow (max-width:450px){.data-stage{height:500px}.metrics-surface{top:24px;left:5%;width:89%}.data-window-label{min-height:45px;padding:12px 16px;font-size:11px;gap:7px}.data-window-meta{font-size:9px}.metrics-heading{padding:22px 17px 12px}.metrics-heading h3{font-size:19px;letter-spacing:-.045em}.data-overline{font-size:9px}.metric-table{width:calc(100% - 34px);margin-inline:17px}.metric-table thead th{padding:9px 8px}.metric-table tbody th{padding:13px 8px;width:38%}.metric-table strong{font-size:13px}.metric-table tbody td{padding:12px 19px 12px 8px;font-size:10px}.metric-table tbody td svg{right:3px;top:26px;width:12px}.metric-footnote{gap:6px;margin:16px 17px 21px;font-size:9px}.fetching-surface{top:62px;left:7%;width:90%}.fetching-heading{padding:18px 16px 13px}.fetching-heading h3{font-size:18px}.fetching-heading p{font-size:10px}.data-providers{margin-inline:16px}.data-provider{padding:12px 10px;gap:9px}.provider-symbol svg{width:20px}.data-provider>div{gap:7px}.data-provider strong{font-size:12px;min-width:70px}.data-provider div>span{font-size:10px}.fetch-list{margin:14px 16px 19px;font-size:10px}.fetch-list>div{padding:9px 0;gap:4px}.fetch-list>div>span{gap:6px}.fetch-list small{font-size:8px}.fetch-list .fetch-list-label{font-size:9px}.attribution-surface{top:115px;left:5%;width:92%}.attribution-heading{padding:21px 17px 18px;gap:10px}.attribution-symbol{width:40px;height:40px;border-radius:10px}.attribution-heading h3{font-size:21px}.attribution-kind{font-size:8px;padding:4px 6px}.attribution-route{margin-inline:17px;gap:6px;padding:13px 11px}.attribution-route strong{font-size:11px}.attribution-route svg{width:13px}.attribution-findings{margin:13px 17px 0}.attribution-findings>div{grid-template-columns:53px 1fr;gap:8px;font-size:10px;padding:10px 0}.attribution-summary{margin:17px 17px 21px;gap:8px;font-size:11px}.data-stage-caption{left:5%;right:4%;bottom:15px;font-size:10px;gap:8px}.data-stage-caption small{font-size:8px}.data-flow-scene[data-step="1"] .metrics-surface{transform:translate(-2px,-10px) scale(.95)}.data-flow-scene[data-step="2"] .metrics-surface{transform:translate(-3px,-10px) scale(.92)}.data-flow-scene[data-step="2"] .fetching-surface{transform:translate(-5px,-26px) scale(.96)}}
@media(prefers-reduced-motion:reduce){.data-surface{transition:none;will-change:auto}}
</style>
