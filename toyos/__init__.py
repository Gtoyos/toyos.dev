from flask import Flask, request, send_from_directory, render_template, redirect
from . import content

app = Flask(__name__)
cnt = content.Cnt()

def create_app():
    return app

# Pages renamed to readable slugs: old URL -> new URL (permanent redirects keep old links working)
REDIRECTS = {
    "portfolio/cs/aiai.html": "portfolio/cs/kolmogorov-cnn-kernels.html",
    "portfolio/cs/basuraGA.html": "portfolio/cs/waste-collection-ga.html",
    "portfolio/cs/custoDPP.html": "portfolio/cs/custodpp.html",
    "portfolio/cs/gutenbergNLP.html": "portfolio/cs/gutenberg-nlp.html",
    "portfolio/cs/onthebitcmplxiteratedmem.html": "portfolio/cs/bit-complexity-iterated-memory.html",
    "portfolio/cs/raytracingKNN.html": "portfolio/cs/raytracing-knn.html",
    "portfolio/software/custoDPP.html": "portfolio/software/custodpp.html",
    "portfolio/software/nparticles.html": "portfolio/software/n-body-simulation.html",
    "portfolio/software/steam.html": "portfolio/software/steam-cli.html",
    "portfolio/software/xwing.html": "portfolio/software/xwing-simulator.html",
    "notes/ae.html": "notes/algoritmos-evolutivos.html",
    "notes/cs156.html": "notes/learning-from-data.html",
    "notes/fbd.html": "notes/bases-de-datos.html",
    "notes/fp.html": "notes/functional-programming.html",
    "notes/iis.html": "notes/ingenieria-de-software.html",
    "notes/redes.html": "notes/redes-de-computadoras.html",
    "notes/tprog.html": "notes/taller-de-programacion.html",
    # Removed pages
    "about/": "",
    "about": "",
    "about/colophon.html": "",
    "about/changelog.html": "",
}

@app.context_processor
def load_site_variables():
    return dict(cnt=cnt)

@app.route('/<path:pth>')
def genericpath(pth):
    if pth in REDIRECTS:
        return redirect('/' + REDIRECTS[pth], code=301)
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
    return render_template(res,title="Guillermo Toyos-Marfurt",edate=cnt.dates["pages/index.html"])

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