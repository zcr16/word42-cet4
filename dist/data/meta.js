window.WORD_META = {
  "version": "2026-10-22.1",
  "builtAt": "2026-10-22",
  "counts": {
    "total": 5329,
    "core": 700,
    "base": 1784,
    "advanced": 3545,
    "cet4": 3848,
    "gk": 3676,
    "sourceCet4": 3849,
    "sourceGk": 3677,
    "sourceUnion": 5331,
    "missingPhonetic": 42
  },
  "foundationCheckIds": [
    "accept",
    "achieve",
    "allow",
    "although",
    "borrow",
    "decide",
    "develop",
    "explain",
    "improve",
    "instead",
    "offer",
    "promise",
    "realize",
    "ability",
    "depend",
    "environment",
    "experience",
    "necessary",
    "suggest",
    "continue"
  ],
  "foundationCheckNote": "20 个衔接词用于发现基础缺口，不估算词汇量，不根据考试分数推断能力。未认识的词可加回学习。",
  "corePlan": {
    "primary": 600,
    "optional": 100,
    "rule": "core 词按 rank 升序，前 600 主学，后 100 选学"
  },
  "selection": "700 冲刺词：高中/四级来源并集排除基础词后，按 ECDICT 的 BNC 与当代语料库排名几何平均排序；只有一项时使用该项。是通用词频优先级，不是四级真题频率榜。",
  "source": {
    "name": "ECDICT",
    "repository": "https://github.com/skywind3000/ECDICT",
    "commit": "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b",
    "license": "MIT",
    "url": "https://github.com/skywind3000/ECDICT/blob/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv",
    "readme": "https://github.com/skywind3000/ECDICT/blob/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/README.md",
    "licenseUrl": "https://github.com/skywind3000/ECDICT/blob/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/LICENSE",
    "sha256": "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf"
  },
  "basicRule": "默认剔除 ECDICT 中考 zk 标签、其明确词形变化、常见英美拼写变体，以及人工补充的明显基础词/常见地理名称。原词仍在完整词库中，可重新启用。该规则不等同逐版小学/初中教材核验。",
  "coverageNote": "四级与高中标签来自 ECDICT，保留该版本标签全量并修正少量源数据问题；尚未与现行官方大纲逐词核对，不宣称官方完整词表或押题命中率。",
  "corrections": [
    {
      "from": "reservior",
      "to": "reservoir",
      "reason": "修正明显拼写错误，释义和音标取同源正确词条"
    },
    {
      "from": "uptodate",
      "to": "up-to-date",
      "reason": "规范连字符并与已有词条合并"
    },
    {
      "from": "cance",
      "to": null,
      "reason": "原条目仅释为人名且无读音/词频，排除疑似误标高考词"
    },
    {
      "from": "CORE",
      "to": "core",
      "reason": "规范普通词大小写"
    },
    {
      "from": "Conservative",
      "to": "conservative",
      "reason": "按一般形容词释义规范大小写"
    },
    {
      "from": "AM",
      "to": "am",
      "reason": "按 be 动词释义规范大小写"
    }
  ],
  "meaningNote": "中文释义及音标源自 ECDICT；界面释义去除独立的专业领域附注行。源词库的少量读音空缺保留为空，不编造。"
};
