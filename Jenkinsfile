pipeline {
    agent any
    stages {
        stage('Build') { 
            steps {
                sh 'npm install'
                sh 'electron-builder --win --x64 --ia32 --pd="electron-packager/win32-x64/MYAPP-win32-x64" --config=builder.json'
            }
        }
    }
}
