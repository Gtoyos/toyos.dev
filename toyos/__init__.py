from flask import Flask, request, send_from_directory, render_template
from . import content

app = Flask(__name__)
cnt = content.Cnt()

def create_app():
    return app

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

# Override the default static file handling
@app.after_request
def add_header(response):
    # Only apply to static files
    if request.path.startswith('/static/'):
        # Set the Cache-Control header for one hour
        response.headers['Cache-Control'] = 'public, max-age=3600'
    return response

@app.errorhandler(404)
def page_not_found(error):
    return render_template('pages/404.html',title="toyos.dev :: 404"), 404