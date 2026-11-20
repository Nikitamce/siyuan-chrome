const assert = require("node:assert/strict");
const {test} = require("node:test");
const {createContentDOM} = require("./helpers/content-dom");

test("Gemini turns preserve user/model roles, order, code and formulas", t => {
    const html = `
      <main>
        <user-query><div class="query-text">Why is the sky blue?</div></user-query>
        <model-response><div class="response-content"><p>Shorter wavelengths scatter more.</p><pre><code>lambda = c / f</code></pre></div></model-response>
        <user-query><div class="query-text">Summarize that.</div></user-query>
        <model-response><div class="response-content"><p>Blue light is scattered more.</p></div></model-response>
      </main>`;
    const {window} = createContentDOM(t,html,{url:"https://gemini.google.com/app"});
    const result=window.extractConversation();
    assert.equal(result.adapter,"Gemini");
    assert.deepEqual(result.turns.map(x=>x.role),["user","assistant","user","assistant"]);
    assert.match(result.element.textContent,/Why is the sky blue/);
    assert.match(result.element.textContent,/Blue light is scattered more/);
    assert.ok(result.element.querySelector("pre code"));
});

test("ChatGPT uses explicit author roles and keeps consecutive assistant turns", t => {
    const html=`
      <main>
        <article data-message-author-role="user"><div class="text-message">Question</div></article>
        <article data-message-author-role="assistant"><div class="markdown"><p>Answer</p></div><button data-testid="copy-turn">Copy</button></article>
        <article data-message-author-role="assistant"><div class="markdown"><p>Continuation</p></div></article>
      </main>`;
    const {window}=createContentDOM(t,html,{url:"https://chatgpt.com/c/test"});
    const result=window.extractConversation();
    assert.deepEqual(result.turns.map(x=>x.role),["user","assistant","assistant"]);
    assert.equal(result.element.querySelectorAll("button").length,0);
    assert.match(result.element.textContent,/Continuation/);
});

test("Claude adapter recognizes test-id role labels", t => {
    const html=`
      <main>
        <div data-testid="user-message"><div class="font-claude-message">Hello Claude</div></div>
        <div data-testid="assistant-message"><div class="font-claude-message"><p>Hello!</p></div></div>
      </main>`;
    const {window}=createContentDOM(t,html,{url:"https://claude.ai/chat/test"});
    assert.deepEqual(window.extractConversation().turns.map(x=>x.role),["user","assistant"]);
});

test("unknown sites do not receive guessed conversation roles", t => {
    const {window}=createContentDOM(t,"<main><p>Plain article</p></main>",{url:"https://example.com/"});
    assert.equal(window.extractConversation(),null);
});
