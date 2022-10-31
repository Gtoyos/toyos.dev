buf = ""
i = 0 
with open("redes.html") as fileobj:
    for line in fileobj:  
       for ch in line: 
           if ch=="$":
               if i%2==0:
                   ch="\\("
                   i+=1
               else:
                   ch="\\)"
                   i+=1
           buf = buf+ch
with open("fbd2.html","w") as f:
    f.write(buf)
