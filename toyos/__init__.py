from flask import Flask
from flask import render_template
from flask import g
from . import content

app = Flask(__name__)
cnt = content.Cnt()

@app.context_processor
def load_site_variables():
    return dict(cnt=cnt,qod=cnt.newQod())

@app.route('/<path:pth>')
def genericpath(pth):
    try:
        if(pth.endswith(".html")):
                title = "toyos.dev :: "+pth.split("/")[-1][:-5].capitalize()
                return render_template('pages/'+pth,title=title,edate=cnt.dates["pages/"+pth])
        else:
                if(pth.endswith("/")):
                    pth = pth[:-1]
                title = "toyos.dev :: "+pth.split("/")[-1].capitalize()
                print('pages/'+pth+"/index.html")
                return render_template('pages/'+pth+"/index.html",title=title,edate=cnt.dates["pages/"+pth+"/index.html"])
    except Exception as e:
        return render_template('pages/404.html',title="toyos.dev :: 404"), 404 

@app.route("/")
def index():
    res = 'pages/index.html'
    return render_template(res,title="toyos.dev :: Home",edate=cnt.dates["pages/index.html"])

@app.errorhandler(404)
def page_not_found(error):
    return render_template('pages/404.html',title="toyos.dev :: 404"), 404