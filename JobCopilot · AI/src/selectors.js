// BOSS 直聘选择器（借鉴即投实测验证版）
const SELECTORS = {
  jobs: {
    jobCard: 'li.job-card-box',
    jobName: 'a.job-name, .job-name, .job-name-text, a[href*="/job_detail/"]',
    jobSalary: '.job-salary, .salary, [class*="job-salary"], [class*="salary"]',
    tagList: '.tag-list li, .tag-list span, [class*="job-tag"] span',
    company: '.boss-name, .company-name a, .company-name, .brand-name, [class*="company-name"], a[href*="/gongsi/"]',
    area: '.company-location, .job-area, .job-area-wrapper, .location, [class*="company-location"], [class*="job-location"]',
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
