const triangle = document.getElementById('totop');
let c = 0;
triangle.addEventListener('click', () => {
  c++;
  if (c === 3) {
    document.getElementById('gardenlink').style.display = '';
    c = 0;
  }
});