pipeline {
    agent any
    
    environment {
        NODEJS_HOME = "${tool 'NodeJS'}"
        PATH = "${env.NODEJS_HOME}/bin:${env.PATH}"
    }

    stages {
        stage('Checkout') {
            steps {
                git branch: 'master', url: 'https://github.com/zachduda/Empanadas.io-App.git'
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm install'
            }
        }

        stage('Install Updates') {
            steps {
                sh 'npm update'
            }
        }

        stage('Build Electron App') {
            steps {
                sh 'npm run build'
            }
        }

        stage('Archive Artifacts') {
            steps {
                // Archive the built executables
                archiveArtifacts artifacts: 'dist/**/*', fingerprint: true
            }
        }
    }

    post {
        success {
            echo 'Build successful!'
        }
        failure {
            echo 'Build failed!'
        }
    }
}
