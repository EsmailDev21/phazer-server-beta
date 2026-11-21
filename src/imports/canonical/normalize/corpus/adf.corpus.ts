/**
 * Step 4.2. Conversion corpus: each case is an input, the markdown it must produce, and the warning CODES it must
 * report. Expected values were reviewed by hand against the source (not copied blindly from output); a change to
 * any of them is a behaviour change and belongs in a review.
 */
import { CorpusCase } from './corpus.types';

export const ADF_CORPUS: CorpusCase[] = [
  {
    "name": "plain",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "Just text."
            }
          ]
        }
      ]
    },
    "markdown": "Just text.",
    "warnings": []
  },
  {
    "name": "two_paras",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "One"
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "Two"
            }
          ]
        }
      ]
    },
    "markdown": "One\n\nTwo",
    "warnings": []
  },
  {
    "name": "marks",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "a "
            },
            {
              "type": "text",
              "text": "b",
              "marks": [
                {
                  "type": "strong"
                }
              ]
            },
            {
              "type": "text",
              "text": " "
            },
            {
              "type": "text",
              "text": "c",
              "marks": [
                {
                  "type": "em"
                }
              ]
            },
            {
              "type": "text",
              "text": " "
            },
            {
              "type": "text",
              "text": "d",
              "marks": [
                {
                  "type": "strike"
                }
              ]
            },
            {
              "type": "text",
              "text": " "
            },
            {
              "type": "text",
              "text": "e",
              "marks": [
                {
                  "type": "code"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "a **b** *c* ~~d~~ `e`",
    "warnings": []
  },
  {
    "name": "marks_ws",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            },
            {
              "type": "text",
              "text": " bold ",
              "marks": [
                {
                  "type": "strong"
                }
              ]
            },
            {
              "type": "text",
              "text": "y"
            }
          ]
        }
      ]
    },
    "markdown": "x **bold** y",
    "warnings": []
  },
  {
    "name": "adjacent",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "a",
              "marks": [
                {
                  "type": "strong"
                }
              ]
            },
            {
              "type": "text",
              "text": "b",
              "marks": [
                {
                  "type": "em"
                }
              ]
            },
            {
              "type": "text",
              "text": "c",
              "marks": [
                {
                  "type": "strong"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "**a**_b_**c**",
    "warnings": []
  },
  {
    "name": "merge_same",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "a",
              "marks": [
                {
                  "type": "strong"
                }
              ]
            },
            {
              "type": "text",
              "text": "b",
              "marks": [
                {
                  "type": "strong"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "**ab**",
    "warnings": []
  },
  {
    "name": "both",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "bi",
              "marks": [
                {
                  "type": "strong"
                },
                {
                  "type": "em"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "***bi***",
    "warnings": []
  },
  {
    "name": "link",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "see "
            },
            {
              "type": "text",
              "text": "docs",
              "marks": [
                {
                  "type": "link",
                  "attrs": {
                    "href": "https://example.com/a b"
                  }
                }
              ]
            },
            {
              "type": "text",
              "text": "."
            }
          ]
        }
      ]
    },
    "markdown": "see [docs](https://example.com/a%20b).",
    "warnings": []
  },
  {
    "name": "link_ws",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "see"
            },
            {
              "type": "text",
              "text": " docs ",
              "marks": [
                {
                  "type": "link",
                  "attrs": {
                    "href": "https://example.com"
                  }
                }
              ]
            },
            {
              "type": "text",
              "text": "now"
            }
          ]
        }
      ]
    },
    "markdown": "see [docs](https://example.com) now",
    "warnings": []
  },
  {
    "name": "link_bad",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x",
              "marks": [
                {
                  "type": "link",
                  "attrs": {
                    "href": "javascript:alert(1)"
                  }
                }
              ]
            },
            {
              "type": "text",
              "text": " y",
              "marks": [
                {
                  "type": "link",
                  "attrs": {
                    "href": "java\tscript:alert(1)"
                  }
                }
              ]
            },
            {
              "type": "text",
              "text": " z",
              "marks": [
                {
                  "type": "link",
                  "attrs": {
                    "href": "data:text/html,hi"
                  }
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "x y z",
    "warnings": [
      "ADF_LINK_DROPPED"
    ]
  },
  {
    "name": "literal_specials",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "1 * 2 _x_ [a](b) <b> `c` ~~d~~ | & &amp; \\"
            }
          ]
        }
      ]
    },
    "markdown": "1 \\* 2 \\_x\\_ \\[a\\](b) \\<b\\> \\`c\\` \\~\\~d\\~\\~ \\| & \\&amp; \\\\",
    "warnings": []
  },
  {
    "name": "line_start",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "# h"
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "- i"
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "1. j"
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "+ k"
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "> l"
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "==="
            }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "---"
            }
          ]
        }
      ]
    },
    "markdown": "\\# h\n\n\\- i\n\n1\\. j\n\n\\+ k\n\n\\> l\n\n\\===\n\n\\---",
    "warnings": []
  },
  {
    "name": "heading",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "heading",
          "attrs": {
            "level": 3
          },
          "content": [
            {
              "type": "text",
              "text": "H3 "
            },
            {
              "type": "text",
              "text": "b",
              "marks": [
                {
                  "type": "strong"
                }
              ]
            }
          ]
        },
        {
          "type": "heading",
          "attrs": {
            "level": 9
          },
          "content": [
            {
              "type": "text",
              "text": "clamped"
            }
          ]
        }
      ]
    },
    "markdown": "### H3 **b**\n\n###### clamped",
    "warnings": []
  },
  {
    "name": "bullets",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "bulletList",
          "content": [
            {
              "type": "listItem",
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "a"
                    }
                  ]
                }
              ]
            },
            {
              "type": "listItem",
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "b"
                    }
                  ]
                },
                {
                  "type": "bulletList",
                  "content": [
                    {
                      "type": "listItem",
                      "content": [
                        {
                          "type": "paragraph",
                          "content": [
                            {
                              "type": "text",
                              "text": "b1"
                            }
                          ]
                        }
                      ]
                    },
                    {
                      "type": "listItem",
                      "content": [
                        {
                          "type": "paragraph",
                          "content": [
                            {
                              "type": "text",
                              "text": "b2"
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "- a\n- b\n  - b1\n  - b2",
    "warnings": []
  },
  {
    "name": "ordered",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "orderedList",
          "attrs": {
            "order": 3
          },
          "content": [
            {
              "type": "listItem",
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "x"
                    }
                  ]
                }
              ]
            },
            {
              "type": "listItem",
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "y"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "3. x\n4. y",
    "warnings": []
  },
  {
    "name": "list_multi_para",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "bulletList",
          "content": [
            {
              "type": "listItem",
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "first"
                    }
                  ]
                },
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "second"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "- first\n\n  second",
    "warnings": []
  },
  {
    "name": "code",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "codeBlock",
          "attrs": {
            "language": "js"
          },
          "content": [
            {
              "type": "text",
              "text": "let a = 1;\nlet b = `2`;"
            }
          ]
        }
      ]
    },
    "markdown": "```js\nlet a = 1;\nlet b = `2`;\n```",
    "warnings": []
  },
  {
    "name": "code_fence",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "codeBlock",
          "content": [
            {
              "type": "text",
              "text": "```\nx\n```"
            }
          ]
        }
      ]
    },
    "markdown": "````\n```\nx\n```\n````",
    "warnings": []
  },
  {
    "name": "code_lang_evil",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "codeBlock",
          "attrs": {
            "language": "js\n# pwn"
          },
          "content": [
            {
              "type": "text",
              "text": "x"
            }
          ]
        }
      ]
    },
    "markdown": "```\nx\n```",
    "warnings": []
  },
  {
    "name": "quote",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "blockquote",
          "content": [
            {
              "type": "paragraph",
              "content": [
                {
                  "type": "text",
                  "text": "q1"
                }
              ]
            },
            {
              "type": "paragraph",
              "content": [
                {
                  "type": "text",
                  "text": "q2"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "> q1\n>\n> q2",
    "warnings": []
  },
  {
    "name": "rule",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "a"
            }
          ]
        },
        {
          "type": "rule"
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "b"
            }
          ]
        }
      ]
    },
    "markdown": "a\n\n---\n\nb",
    "warnings": []
  },
  {
    "name": "hardbreak",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "a"
            },
            {
              "type": "hardBreak"
            },
            {
              "type": "text",
              "text": "b"
            }
          ]
        }
      ]
    },
    "markdown": "a\\\nb",
    "warnings": []
  },
  {
    "name": "table",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "table",
          "content": [
            {
              "type": "tableRow",
              "content": [
                {
                  "type": "tableHeader",
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "H1"
                        }
                      ]
                    }
                  ]
                },
                {
                  "type": "tableHeader",
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "H2"
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            {
              "type": "tableRow",
              "content": [
                {
                  "type": "tableCell",
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "a|b"
                        }
                      ]
                    }
                  ]
                },
                {
                  "type": "tableCell",
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "1"
                        }
                      ]
                    },
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "2"
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "| H1 | H2 |\n| --- | --- |\n| a\\|b | 1<br>2 |",
    "warnings": []
  },
  {
    "name": "table_ragged",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "table",
          "content": [
            {
              "type": "tableRow",
              "content": [
                {
                  "type": "tableCell",
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "a"
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            {
              "type": "tableRow",
              "content": [
                {
                  "type": "tableCell",
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "b"
                        }
                      ]
                    }
                  ]
                },
                {
                  "type": "tableCell",
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "c"
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "| a |  |\n| --- | --- |\n| b | c |",
    "warnings": []
  },
  {
    "name": "table_span",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "table",
          "content": [
            {
              "type": "tableRow",
              "content": [
                {
                  "type": "tableHeader",
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "A"
                        }
                      ]
                    }
                  ]
                },
                {
                  "type": "tableHeader",
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "B"
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            {
              "type": "tableRow",
              "content": [
                {
                  "type": "tableCell",
                  "attrs": {
                    "colspan": 2
                  },
                  "content": [
                    {
                      "type": "paragraph",
                      "content": [
                        {
                          "type": "text",
                          "text": "wide"
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "| A | B |\n| --- | --- |\n| wide |  |",
    "warnings": [
      "ADF_TABLE_SPAN"
    ]
  },
  {
    "name": "mention",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "hi "
            },
            {
              "type": "mention",
              "attrs": {
                "id": "1",
                "text": "@Ana Lima"
              }
            },
            {
              "type": "text",
              "text": "!"
            }
          ]
        }
      ]
    },
    "markdown": "hi @Ana Lima!",
    "warnings": []
  },
  {
    "name": "emoji",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "emoji",
              "attrs": {
                "shortName": ":smile:",
                "text": "😄"
              }
            },
            {
              "type": "text",
              "text": " ok "
            },
            {
              "type": "emoji",
              "attrs": {
                "shortName": ":custom:"
              }
            }
          ]
        }
      ]
    },
    "markdown": "😄 ok :custom:",
    "warnings": []
  },
  {
    "name": "status_date",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "status",
              "attrs": {
                "text": "IN PROGRESS",
                "color": "blue"
              }
            },
            {
              "type": "text",
              "text": " due "
            },
            {
              "type": "date",
              "attrs": {
                "timestamp": "1767225600000"
              }
            }
          ]
        }
      ]
    },
    "markdown": "\\[IN PROGRESS\\] due 2026-01-01",
    "warnings": []
  },
  {
    "name": "card",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "inlineCard",
              "attrs": {
                "url": "https://example.com/browse/ENG-1"
              }
            }
          ]
        },
        {
          "type": "blockCard",
          "attrs": {
            "url": "javascript:x"
          }
        }
      ]
    },
    "markdown": "[https://example.com/browse/ENG-1](https://example.com/browse/ENG-1)",
    "warnings": [
      "ADF_LINK_DROPPED"
    ]
  },
  {
    "name": "media_file",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "mediaSingle",
          "content": [
            {
              "type": "media",
              "attrs": {
                "id": "abc-123",
                "type": "file",
                "collection": "c",
                "alt": "shot.png"
              }
            }
          ]
        }
      ]
    },
    "markdown": "[shot.png](attachment:abc-123)",
    "warnings": [
      "ADF_MEDIA_PLACEHOLDER"
    ]
  },
  {
    "name": "media_external",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "mediaSingle",
          "content": [
            {
              "type": "media",
              "attrs": {
                "type": "external",
                "url": "https://x.com/a.png",
                "alt": "pic"
              }
            }
          ]
        }
      ]
    },
    "markdown": "![pic](https://x.com/a.png)",
    "warnings": []
  },
  {
    "name": "tasks",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "taskList",
          "content": [
            {
              "type": "taskItem",
              "attrs": {
                "state": "DONE"
              },
              "content": [
                {
                  "type": "text",
                  "text": "done"
                }
              ]
            },
            {
              "type": "taskItem",
              "attrs": {
                "state": "TODO"
              },
              "content": [
                {
                  "type": "text",
                  "text": "open ",
                  "marks": [
                    {
                      "type": "strong"
                    }
                  ]
                },
                {
                  "type": "text",
                  "text": "item"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "- [x] done\n- [ ] **open** item",
    "warnings": []
  },
  {
    "name": "panel",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "panel",
          "attrs": {
            "panelType": "warning"
          },
          "content": [
            {
              "type": "paragraph",
              "content": [
                {
                  "type": "text",
                  "text": "careful"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "> **Warning:**\n>\n> careful",
    "warnings": []
  },
  {
    "name": "expand",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "expand",
          "attrs": {
            "title": "More"
          },
          "content": [
            {
              "type": "paragraph",
              "content": [
                {
                  "type": "text",
                  "text": "hidden"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "**More**\n\nhidden",
    "warnings": []
  },
  {
    "name": "layout",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "layoutSection",
          "content": [
            {
              "type": "layoutColumn",
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "left"
                    }
                  ]
                }
              ]
            },
            {
              "type": "layoutColumn",
              "content": [
                {
                  "type": "paragraph",
                  "content": [
                    {
                      "type": "text",
                      "text": "right"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "left\n\nright",
    "warnings": []
  },
  {
    "name": "extension",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "extension",
          "attrs": {
            "extensionType": "x"
          }
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "after"
            }
          ]
        }
      ]
    },
    "markdown": "after",
    "warnings": [
      "ADF_UNSUPPORTED_NODE"
    ]
  },
  {
    "name": "unknown_block",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "futureNode",
          "content": [
            {
              "type": "paragraph",
              "content": [
                {
                  "type": "text",
                  "text": "kept"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "kept",
    "warnings": [
      "ADF_UNSUPPORTED_NODE"
    ]
  },
  {
    "name": "unknown_mark",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "m",
              "marks": [
                {
                  "type": "hologram"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "m",
    "warnings": [
      "ADF_MARK_DROPPED"
    ]
  },
  {
    "name": "empty",
    "input": {
      "type": "doc",
      "version": 1,
      "content": []
    },
    "markdown": "",
    "warnings": []
  },
  {
    "name": "empty_para",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": []
        },
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "x"
            }
          ]
        }
      ]
    },
    "markdown": "x",
    "warnings": []
  },
  {
    "name": "decision",
    "input": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "decisionList",
          "content": [
            {
              "type": "decisionItem",
              "attrs": {
                "state": "DECIDED"
              },
              "content": [
                {
                  "type": "text",
                  "text": "use Postgres"
                }
              ]
            }
          ]
        }
      ]
    },
    "markdown": "- **Decision:** use Postgres",
    "warnings": []
  }
];
