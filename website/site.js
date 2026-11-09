const chinese = {
  skip: "跳转到正文",
  home: "Intent 首页",
  byline: "ZEROTHLAB 出品",
  nav: "主导航",
  navProduct: "产品",
  navWorkflow: "工作方式",
  navDeploy: "自行部署",
  githubLabel: "在 GitHub 查看 Intent",
  releaseNote: "开源，为你的工作空间而构建。",
  heroEyebrow: "AI 原生 CRM",
  heroTitleOne: "理解意图，",
  heroTitleTwo: "推动业务向前。",
  heroDescription: "让客户证据变成经过思考的下一步。为团队配备一个始终关联原始资料、尊重人工决策、持续关注实际结果的助手。",
  install: "部署 Intent",
  seeProduct: "了解产品",
  heroDetail: "Apache 2.0 · 自行部署 · English & 简体中文",
  approach: "Intent 的工作方式",
  asideHeading: "从客户的原话，走向团队的下一步。",
  miniOne: "证据，保留原文",
  miniTwo: "事实，由人核实",
  miniThree: "行动，明确审批",
  miniFour: "结果，如实记录",
  productEyebrow: "让上下文持续伴随工作",
  productTitle: "一起思考的伙伴。\n共同信赖的业务记录。",
  productDescription: "私人对话与有权访问的客户记录相连。沿着建议找到原始证据，再直接打开需要处理的业务事项。",
  frameLabel: "Intent / 知行助手",
  frameStatus: "虚构演示工作空间",
  screenshotLink: "查看完整的 Intent 助手截图",
  screenshotAlt: "Intent 助手的真实应用截图，展示虚构客户对话、原文证据、事实核实及业务记录链接。",
  screenshotCaption: "真实应用截图。使用虚构记录、确定性的 Fixture 演示模型和模拟投递。",
  screenshotHint: "点击图片查看完整截图 ↗",
  pointOneTitle: "让对话有据可循",
  pointOneText: "客户事实始终关联原始引文。人工核实的结果会进入下一次建议的上下文。",
  pointTwoTitle: "从工作台找到下一步",
  pointTwoText: "集中查看待核实的事实、待审阅的建议、已分派的事项，以及需要恢复的工作。",
  pointThreeTitle: "连接完整的业务背景",
  pointThreeText: "围绕客户记录，关联商机、合同、回款与过往决策，让业务背景随时可查。",
  workflowEyebrow: "为人的判断而设计",
  workflowTitle: "每个行动都有依据。\n每个决策都有负责人。",
  workflowDescription: "Intent 连接完整工作流程，同时明确区分证据、建议、审批和回执。",
  stepOneTitle: "汇入客户证据",
  stepOneText: "将会议记录、往来沟通和客户反馈保存在客户工作空间中，保留真实原话。",
  stepTwoTitle: "审阅下一步建议",
  stepTwoText: "对照来源核实提取的事实。请助手梳理上下文，再编辑或不采用它的建议。",
  stepThreeTitle: "批准明确的行动",
  stepThreeText: "审批绑定当前审阅的准确版本。内容、权限或投递设置发生变化，原执行授权随即失效。",
  stepFourTitle: "记录并反馈结果",
  stepFourText: "记录回执、客户回复、事项和经营结果。投递结果不明时，必须先对账确认，才能继续。",
  workflowNote: "消息已投递、客户已同意、合同已签订和款项已到账，是不同的业务事件。Intent 始终分别记录。",
  deployEyebrow: "你的基础设施，你的工作空间",
  deployTitle: "代码公开可查。\n部署由你掌握。",
  deployDescription: "在自己的基础设施上部署 Intent。选择模型服务，配置投递网关，并在每个工作空间内管理访问权限。",
  readDeployment: "阅读部署指南",
  licenseTitle: "Apache License 2.0",
  licenseText: "按照开源许可查看、使用、修改代码，并参与贡献。",
  buildLabel: "获取发布候选镜像",
  copy: "复制",
  requirementsTitle: "部署所需环境",
  requirementOne: "Docker Engine 和 Compose v2",
  requirementTwo: "PostgreSQL 16 和持久化的 Temporal 服务",
  requirementThree: "提供同源访问的 HTTPS 反向代理",
  buildNote: "该已发布镜像为 0.4.0-rc.1 发布候选版本。请按照部署指南配置服务、初始化管理员账号，并在正式使用前验证你的部署环境。",
  detailsEyebrow: "了解你正在运行的产品",
  detailsTitle: "清晰、可靠的起点。",
  detailsDescription: "实用的默认设置、明确的集成方式和如实说明的能力边界。",
  demoTitle: "公开在线演示",
  demoStatus: "尚未部署。",
  faqOneTitle: "Intent 默认会向 AI 服务发送数据吗？",
  faqOneText: "新工作空间默认使用确定性的 Fixture 演示模型和模拟投递。真实模型推理需要管理员配置、测试并启用 DeepSeek 或兼容接口。向真实客户投递也需要单独配置网关。",
  faqTwoTitle: "团队可以管理哪些工作？",
  faqTwoText: "客户证据、事实核实、私人助手对话、商机、预测、事项、合同、分期、付款和退款。工作空间管理员还可以管理成员、四种内置角色、自定义字段、集成和审计记录。",
  faqThreeTitle: "正式使用前需要验证什么？",
  faqThreeText: "请验证模型服务、投递网关、HTTPS 入口、访问控制、备份恢复及预期负载。目前不包含 SSO、MFA、邀请邮件和密码找回邮件。本地测试通过，不代表你的基础设施已经具备生产运行条件。",
  faqFourTitle: "支持哪些语言和业务设置？",
  faqFourText: "界面支持英语和简体中文，客户证据保留原始语言。币种目前为人民币，业务日期使用 Asia/Shanghai 时区。财务记录用于登记业务事件；Intent 不发起银行转账，也不进行收入确认。",
  closingEyebrow: "理解，判断，持续向前",
  closingTitle: "让下一步真正有用。",
  viewGitHub: "在 GitHub 探索",
  viewReleases: "查看发布版本",
  footerByline: "ZerothLab 出品",
  footerTagline: "理解意图，推动业务向前。",
  footerNav: "项目链接",
  license: "许可证",
  security: "安全政策",
  feedback: "反馈"
};

const textNodes = [...document.querySelectorAll("[data-i18n]")];
const englishText = new Map(textNodes.map((element) => [element,
  [...element.childNodes].map((node) => node.nodeName === "BR" ? "\n" : node.textContent).join("")
]));
const attributeNodes = [
  ...document.querySelectorAll("[data-i18n-aria], [data-i18n-alt]")
].map((element) => {
  const attribute = element.hasAttribute("data-i18n-aria") ? "aria-label" : "alt";
  const key = element.dataset.i18nAria || element.dataset.i18nAlt;
  return { element, attribute, key, english: element.getAttribute(attribute) };
});
const languageSwitch = document.querySelector("#language-switch");
const description = document.querySelector('meta[name="description"]');
const openGraphDescription = document.querySelector('meta[property="og:description"]');
const englishDescription = description.content;
const englishOpenGraphDescription = openGraphDescription.content;
const copyButton = document.querySelector("#copy-command");
const copyStatus = document.querySelector("#copy-status");
let locale = "en";

function applyLanguage(nextLocale) {
  locale = nextLocale === "zh-CN" ? "zh-CN" : "en";
  const isChinese = locale === "zh-CN";
  document.documentElement.lang = locale;
  textNodes.forEach((element) => {
    element.textContent = isChinese ? chinese[element.dataset.i18n] : englishText.get(element);
  });
  attributeNodes.forEach(({ element, attribute, key, english }) => {
    element.setAttribute(attribute, isChinese ? chinese[key] : english);
  });
  languageSwitch.textContent = isChinese ? "English" : "简体中文";
  languageSwitch.lang = isChinese ? "en" : "zh-CN";
  languageSwitch.setAttribute("aria-label", isChinese ? "Switch to English" : "Switch to Simplified Chinese");
  document.title = isChinese ? "Intent — AI 原生 CRM" : "Intent — The AI-native CRM";
  document.querySelector('meta[property="og:title"]').content = document.title;
  description.content = isChinese ? "Intent 是开源、可自行部署的 CRM，连接客户证据、人工审阅、经审批的行动和可核实的结果。" : englishDescription;
  openGraphDescription.content = isChinese ? "理解意图，推动业务向前。以证据、人的判断和可追溯行动为基础的开源 CRM。" : englishOpenGraphDescription;
  copyStatus.textContent = "";
}

try {
  applyLanguage(localStorage.getItem("intent-site-language"));
} catch {
  applyLanguage("en");
}

languageSwitch.addEventListener("click", () => {
  applyLanguage(locale === "en" ? "zh-CN" : "en");
  try {
    localStorage.setItem("intent-site-language", locale);
  } catch {
    // Language switching remains available when browser storage is disabled.
  }
});

copyButton.addEventListener("click", async () => {
  copyButton.disabled = true;
  try {
    await navigator.clipboard.writeText(document.querySelector("#install-command").textContent);
    copyStatus.textContent = locale === "zh-CN" ? "命令已复制。" : "Commands copied.";
    copyButton.textContent = locale === "zh-CN" ? "已复制" : "Copied";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#install-command"));
    selection?.removeAllRanges();
    selection?.addRange(range);
    copyStatus.textContent = locale === "zh-CN" ? "无法自动复制。命令已选中，请手动复制。" : "Automatic copying is unavailable. The commands are selected for manual copying.";
    copyButton.textContent = locale === "zh-CN" ? "请手动复制" : "Copy manually";
  } finally {
    copyButton.disabled = false;
  }
});
