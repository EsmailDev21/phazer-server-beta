/**
 * Step 4.2. Conversion corpus: each case is an input, the markdown it must produce, and the warning CODES it must
 * report. Expected values were reviewed by hand against the source (not copied blindly from output); a change to
 * any of them is a behaviour change and belongs in a review.
 */
import { CorpusCase } from './corpus.types';

export const HTML_CORPUS: CorpusCase[] = [
  {
    "name": "p",
    "input": "<p>a <b>b</b> <i>c</i> <s>d</s> <code>e</code></p>",
    "markdown": "a **b** *c* ~~d~~ `e`",
    "warnings": []
  },
  {
    "name": "entities",
    "input": "<p>a &amp; b &lt;c&gt; &copy; &#x1F600; &nbsp;x</p>",
    "markdown": "a & b \\<c\\> © 😀  x",
    "warnings": []
  },
  {
    "name": "ws",
    "input": "<p>  lots   of\n  space  </p><p>next</p>",
    "markdown": "lots of space\n\nnext",
    "warnings": []
  },
  {
    "name": "nested_inline",
    "input": "<p><b>bold <i>both</i> bold</b></p>",
    "markdown": "**bold** ***both*** **bold**",
    "warnings": []
  },
  {
    "name": "link",
    "input": "<p><a href=\"https://x.com/a?b=1&c=2\">go</a> <a href=\"/rel\">rel</a> <a href=\"#top\">top</a> <a href=\"javascript:alert(1)\">js</a></p>",
    "options": {
      "baseUrl": "https://tracker.example.com/"
    },
    "markdown": "[go](https://x.com/a?b=1&c=2) [rel](https://tracker.example.com/rel) top js",
    "warnings": [
      "HTML_LINK_DROPPED"
    ]
  },
  {
    "name": "img",
    "input": "<p><img src=\"https://x.com/a.png\" alt=\"A [1]\"> <img src=\"data:image/png;base64,AAAA\" alt=\"d\"> <img src=\"/up/x.png\"></p>",
    "options": {
      "baseUrl": "https://tracker.example.com/"
    },
    "markdown": "![A \\[1\\]](https://x.com/a.png) ![](https://tracker.example.com/up/x.png)",
    "warnings": [
      "HTML_IMAGE_DROPPED"
    ]
  },
  {
    "name": "script",
    "input": "<p>before</p><script>alert(\"secret\")</script><style>p{color:red}</style><p>after</p><iframe src=\"https://evil\"></iframe><svg><text>svgtext</text></svg>",
    "markdown": "before\n\nafter",
    "warnings": [
      "HTML_ELEMENT_DROPPED"
    ]
  },
  {
    "name": "handlers",
    "input": "<p onclick=\"steal()\" style=\"x\">text<img src=\"https://x.com/i.png\" onerror=\"bad()\"></p>",
    "markdown": "text![](https://x.com/i.png)",
    "warnings": []
  },
  {
    "name": "headings",
    "input": "<h1>One</h1><h2>Two <em>em</em></h2><h6>Six</h6>",
    "markdown": "# One\n\n## Two *em*\n\n###### Six",
    "warnings": []
  },
  {
    "name": "lists",
    "input": "<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul><ol start=\"4\"><li>x</li><li>y</li></ol>",
    "markdown": "- a\n- b\n  - b1\n\n4. x\n5. y",
    "warnings": []
  },
  {
    "name": "tasks",
    "input": "<ul><li><input type=\"checkbox\" checked> done</li><li><input type=\"checkbox\"> todo</li><li>plain</li></ul>",
    "markdown": "- [x] done\n- [ ] todo\n- plain",
    "warnings": []
  },
  {
    "name": "li_blocks",
    "input": "<ul><li><p>one</p><p>two</p></li></ul>",
    "markdown": "- one\n\n  two",
    "warnings": []
  },
  {
    "name": "pre",
    "input": "<pre><code class=\"language-ts\">const a = 1;\n  indented\n</code></pre>",
    "markdown": "```ts\nconst a = 1;\n  indented\n```",
    "warnings": []
  },
  {
    "name": "pre_plain",
    "input": "<pre>a\n  b</pre>",
    "markdown": "```\na\n  b\n```",
    "warnings": []
  },
  {
    "name": "quote",
    "input": "<blockquote><p>q1</p><p>q2</p></blockquote>",
    "markdown": "> q1\n>\n> q2",
    "warnings": []
  },
  {
    "name": "table",
    "input": "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2<br>3</td></tr></tbody></table>",
    "markdown": "| A | B |\n| --- | --- |\n| 1 | 2<br>3 |",
    "warnings": []
  },
  {
    "name": "table_nested",
    "input": "<table><tr><td>x<table><tr><td>inner</td></tr></table></td></tr></table>",
    "markdown": "| x<br>inner |\n| --- |",
    "warnings": []
  },
  {
    "name": "br_hr",
    "input": "<p>a<br>b</p><hr><p>c</p>",
    "markdown": "a\\\nb\n\n---\n\nc",
    "warnings": []
  },
  {
    "name": "div_soup",
    "input": "<div>one<div>two</div>three</div>",
    "markdown": "one\n\ntwo\n\nthree",
    "warnings": []
  },
  {
    "name": "malformed",
    "input": "<p>unclosed <b>bold <i>both</p><p>next",
    "markdown": "unclosed **bold** ***both***\n\n***next***",
    "warnings": []
  },
  {
    "name": "literal_specials",
    "input": "<p>1 * 2 _x_ [a](b) # not heading</p><p>- item</p><p>1. num</p>",
    "markdown": "1 \\* 2 \\_x\\_ \\[a\\](b) # not heading\n\n\\- item\n\n1\\. num",
    "warnings": []
  },
  {
    "name": "dl",
    "input": "<dl><dt>Term</dt><dd>Definition</dd></dl>",
    "markdown": "**Term**\n\nDefinition",
    "warnings": []
  },
  {
    "name": "details",
    "input": "<details><summary>Sum</summary><p>body</p></details>",
    "markdown": "**Sum**\n\nbody",
    "warnings": []
  },
  {
    "name": "empty",
    "input": "",
    "markdown": "",
    "warnings": []
  },
  {
    "name": "only_ws",
    "input": "  \n ",
    "markdown": "",
    "warnings": []
  },
  {
    "name": "plain_text",
    "input": "just text no tags",
    "markdown": "just text no tags",
    "warnings": []
  },
  {
    "name": "comment",
    "input": "<p>a<!-- hidden --> b</p>",
    "markdown": "a b",
    "warnings": []
  },
  {
    "name": "button_form",
    "input": "<form><button>Click</button><select><option>o1</option></select><p>kept</p></form>",
    "markdown": "kept",
    "warnings": []
  }
];
