// BOSS 直聘选择器（借鉴即投实测验证版）
const SELECTORS = {
  jobs: {
    // BOSS 不同版本/页面的卡片类名有差异，都试一遍
    jobCard: 'li.job-card-box, .job-card-wrapper, li[class*="job-card"]',
    jobName: '.job-name',
    jobSalary: '.job-salary, .salary',
    jobArea: '.company-location, [class*="company-location"], .job-area, [class*="job-area"]',
    tagList: '.tag-list li, .job-card-footer .tag-list li, [class*="job-tag"] li',
    // 当前版卡片：公司名藏在 .boss-name（链接 /gongsi/ 公司页）；旧版在 .company-name
    company: '.boss-info .boss-name, .boss-name, .company-info .company-name, .company-name, [class*="company-name"]',
    immediateChatBtn: 'a.op-btn-chat'
  },
  chat: {
    userList: '.user-list-content li',
    userName: '.geek-name, .name-text, [class*="name"]',
    userCompany: '.title-box .name-box, [class*="company"]',
    chatInput: 'div#chat-input.chat-input',
    btnSend: 'button.btn-send',
    imageUpload: '.btn-sendimg input[type=file]',
    messageSent: '.item-myself'
  }
};

const CITY_MAP = {
  '全国':'100010000','北京':'101010100','上海':'101020100','广州':'101280100','深圳':'101280600',
  '杭州':'101210100','成都':'101270100','武汉':'101200100','西安':'101110100','南京':'101190100',
  '苏州':'101190400','天津':'101030100','重庆':'101040100','长沙':'101250100','郑州':'101180100',
  '沈阳':'101070100','青岛':'101120200','合肥':'101220100','厦门':'101230200','福州':'101230100',
  '济南':'101120100','宁波':'101210400','东莞':'101281600','无锡':'101190200','昆明':'101290100',
  '哈尔滨':'101050100','长春':'101060100','大连':'101070200','石家庄':'101090100'
};
