var texts = [
    "If I have seen further it is by standing on the shoulders of Giants. -Issac Newton",
    "The most effective debugging tool is still careful thought, coupled with judiciously placed print statements. -Brian Kernighan",
    "Don't document bad code - rewrite it. - Brian Kernighan",
    `What business of mine is the future? No doubt Seldon has foreseen it and prepared against it. There will be other crises in the time to
    come when money power has become as dead a force as religion is now. Let my successors solve those new problems, as I have solved the one of today. - Foundation (Isaac Asimov)
    `
  ];
  
  document.getElementById('quote').innerHTML = texts[Math.floor(Math.random()*texts.length)];